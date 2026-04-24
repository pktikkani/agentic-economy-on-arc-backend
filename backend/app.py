from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import dotenv_values
from fasta2a.client import A2AClient
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import httpx
from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.models.google import GoogleModelSettings


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPLORER = os.environ.get("ARC_EXPLORER", "https://testnet.arcscan.app")
CHAIN_ID = int(os.environ.get("ARC_CHAIN_ID", "5042002"))
BROKER_IDS = ["A", "B", "C", "D", "E"]
SELLER_BROKER_PORTS = [3001, 3002, 3003, 3004, 3005]
seller_server_proc: subprocess.Popen[str] | None = None
DEFAULT_FIFTY_CONCURRENCY = 3
MAX_FIFTY_CONCURRENCY = 5


class TaskProfile(BaseModel):
    service: str
    complexity: str
    normalized_input: str
    reason: str


class BrokerAssessment(BaseModel):
    broker_id: str
    broker_name: str
    service: str
    fit_score: float
    reason: str


class BrokerDecision(BaseModel):
    broker_id: str
    reason: str


class JudgeScore(BaseModel):
    quality: float
    reason: str


app = FastAPI(title="Arc A2A Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


DEMO_TASKS = [
    "Classify sentiment: 'I absolutely love the new dashboard.'",
    "What is the USD price of BTC?",
    "Summarize: 'Arc is a stablecoin-native L1 where USDC is the gas token and finality is sub-second.'",
    "Classify sentiment: 'Shipping took 3 weeks and arrived damaged.'",
    "What is the USD price of ETH?",
    "Summarize: 'Circle Nanopayments enables gas-free USDC transfers as small as one millionth of a dollar via EIP-3009 signed authorizations and off-chain batching.'",
    "Classify sentiment: 'Best purchase I've made all year!'",
    "What is the USD price of SOL?",
    "Summarize: 'The x402 standard uses HTTP 402 Payment Required to negotiate per-request pricing between client and server.'",
    "Classify sentiment: 'Terrible customer service, will not buy again.'",
]


def load_env() -> dict[str, str]:
    loaded = {k: v for k, v in dotenv_values(REPO_ROOT / ".env").items() if v is not None}
    for key, value in loaded.items():
        os.environ.setdefault(key, value)
    if os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY"):
        os.environ["GOOGLE_API_KEY"] = os.environ["GOOGLE_GENERATIVE_AI_API_KEY"]
    os.environ.pop("GEMINI_API_KEY", None)
    return {**loaded, **os.environ}


def sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def task_slice(count: int) -> list[str]:
    safe_count = max(1, count)
    return [DEMO_TASKS[index % len(DEMO_TASKS)] for index in range(safe_count)]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def bounded_fifty_concurrency(total: int, requested: int | None = None) -> int:
    configured = requested
    if configured is None:
        try:
            configured = int(os.environ.get("FIFTY_CONCURRENCY", str(DEFAULT_FIFTY_CONCURRENCY)))
        except ValueError:
            configured = DEFAULT_FIFTY_CONCURRENCY
    return max(1, min(MAX_FIFTY_CONCURRENCY, configured, total))


def run_json(*args: str) -> dict[str, Any]:
    try:
        result = subprocess.run(list(args), cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as error:
        detail = "\n".join(part for part in [error.stderr.strip(), error.stdout.strip()] if part)
        command = " ".join(args)
        raise RuntimeError(detail or f"{command} exited with status {error.returncode}") from error
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        command = " ".join(args)
        raise RuntimeError(f"{command} returned non-JSON output: {result.stdout[:500]}") from error


def write_receipt(filename: str, payload: dict[str, Any]) -> str:
    receipt_dir = REPO_ROOT / "demo-output"
    receipt_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = receipt_dir / filename
    receipt_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return str(receipt_path.relative_to(REPO_ROOT))


def process_error(proc: subprocess.Popen[str]) -> str:
    if proc.stderr is None:
        return ""
    try:
        return proc.stderr.read().strip()
    except Exception:
        return ""


async def wait_for_a2a(
    base_url: str, proc: subprocess.Popen[str] | None = None, timeout_s: float = 20.0
) -> None:
    started = time.time()
    payload = {"jsonrpc": "2.0", "id": "readiness", "method": "tasks/get", "params": {"id": "__ready__"}}
    async with httpx.AsyncClient(base_url=base_url, timeout=1.0) as client:
        while time.time() - started < timeout_s:
            if proc is not None and proc.poll() is not None:
                detail = process_error(proc)
                raise RuntimeError(
                    f"A2A sidecar exited before becoming ready: {base_url}"
                    + (f" ({detail})" if detail else "")
                )
            try:
                response = await client.post("/", json=payload)
                if response.status_code < 500:
                    return
            except httpx.HTTPError:
                await asyncio.sleep(0.2)
                continue
            await asyncio.sleep(0.2)
    raise TimeoutError(f"A2A server did not become ready: {base_url}")


async def brokers_ready() -> bool:
    async with httpx.AsyncClient(timeout=1.0) as client:
        for port in SELLER_BROKER_PORTS:
            try:
                response = await client.get(f"http://127.0.0.1:{port}/health")
            except httpx.HTTPError:
                return False
            if response.status_code != 200:
                return False
    return True


async def wait_for_seller_server(proc: subprocess.Popen[str], timeout_s: float = 30.0) -> None:
    started = time.time()
    while time.time() - started < timeout_s:
        if await brokers_ready():
            return
        if proc.poll() is not None:
            detail = process_error(proc)
            raise RuntimeError(
                "Broker seller server exited before becoming ready"
                + (f": {detail}" if detail else "")
            )
        await asyncio.sleep(0.3)
    raise TimeoutError("Broker seller server did not expose ports 3001-3005 in time")


async def ensure_seller_server() -> None:
    global seller_server_proc
    if await brokers_ready():
        return

    env = load_env()
    if seller_server_proc is None or seller_server_proc.poll() is not None:
        seller_server_proc = subprocess.Popen(
            ["npx", "tsx", "src/brokers/seller-server.ts"],
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
    await wait_for_seller_server(seller_server_proc)


def stop_seller_server() -> None:
    global seller_server_proc
    if seller_server_proc is not None and seller_server_proc.poll() is None:
        stop_processes([seller_server_proc])
    seller_server_proc = None


async def wait_for_sidecars(port_map: dict[str, int], procs: list[subprocess.Popen[str]]) -> None:
    await asyncio.gather(
        *[
            wait_for_a2a(f"http://127.0.0.1:{port}", proc)
            for port, proc in zip(port_map.values(), procs, strict=True)
        ]
    )


async def poll_a2a_result(client: A2AClient, task_id: str, timeout_s: float = 45.0) -> dict[str, Any]:
    started = time.time()
    while time.time() - started < timeout_s:
        task = await client.get_task(task_id)
        state = task["result"]["status"]["state"]
        if state == "completed":
            return task
        if state in {"failed", "canceled"}:
            raise RuntimeError(f"A2A task {task_id} ended with state={state}")
        await asyncio.sleep(0.3)
    raise TimeoutError(f"A2A task {task_id} timed out")


async def get_broker_assessment(base_url: str, prompt: str) -> BrokerAssessment:
    client = A2AClient(base_url)
    try:
        response = await client.send_message(
            {
                "role": "user",
                "kind": "message",
                "message_id": str(uuid.uuid4()),
                "parts": [{"kind": "text", "text": prompt}],
            }
        )
        task = await poll_a2a_result(client, response["result"]["id"])
        data = task["result"]["artifacts"][0]["parts"][0]["data"]["result"]
        return BrokerAssessment.model_validate(data)
    finally:
        await client.http_client.aclose()


def spawn_sidecars(port_map: dict[str, int]) -> list[subprocess.Popen[str]]:
    env = load_env()
    procs: list[subprocess.Popen[str]] = []
    for broker_id, port in port_map.items():
        procs.append(
            subprocess.Popen(
                [sys.executable, "-m", "backend.broker_sidecar", "--broker-id", broker_id, "--port", str(port)],
                cwd=REPO_ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
        )
    return procs


def stop_processes(procs: list[subprocess.Popen[str]]) -> None:
    for proc in procs:
        proc.terminate()
    for proc in procs:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def agents() -> tuple[Agent, Agent, Agent]:
    settings = GoogleModelSettings(google_thinking_config={"thinking_level": "low"})
    return (
        Agent(
            "google-gla:gemini-3-flash-preview",
            output_type=TaskProfile,
            model_settings=settings,
            instructions=(
                "Classify the incoming task. Return service as one of: sentiment, price-lookup, summarize. "
                "Return complexity as one of: low, medium, high. normalized_input should be the exact payload "
                "that should be sent to the broker."
            ),
        ),
        Agent(
            "google-gla:gemini-3-flash-preview",
            output_type=BrokerDecision,
            model_settings=settings,
            instructions=(
                "Choose exactly one broker. Prefer matching service first, then stronger reputation and fit_score. "
                "When quality looks close, prefer the cheaper broker. Return broker_id and one short reason."
            ),
        ),
        Agent(
            "google-gla:gemini-3-flash-preview",
            output_type=JudgeScore,
            model_settings=settings,
            instructions=(
                "You are an objective judge evaluating an AI service output. Score quality from 0 to 1. "
                "Consider correctness, relevance, and JSON shape if expected."
            ),
        ),
    )


async def demo_events(tasks_count: int) -> AsyncIterator[dict[str, Any]]:
    load_env()
    profile_agent, requester_agent, judge_agent = agents()
    tasks = task_slice(tasks_count)
    state = run_json("npx", "tsx", "scripts/broker-state-json.ts")["brokers"]
    port_map = {broker_id: free_port() for broker_id in BROKER_IDS}
    procs = spawn_sidecars(port_map)

    try:
        await wait_for_sidecars(port_map, procs)
        yield {
            "type": "run_started",
            "totalTasks": len(tasks),
            "model": "gemini-3-flash-preview",
            "chainId": CHAIN_ID,
            "explorer": EXPLORER,
        }

        completed = 0
        total_spent = 0.0
        latencies: list[int] = []
        picks: dict[str, int] = {}

        for index, task in enumerate(tasks, start=1):
            task_started = time.time()
            yield {"type": "task_started", "index": index, "total": len(tasks), "task": task}
            profile = (await profile_agent.run(task)).output
            matching = [broker for broker in state if broker["service"] == profile.service]
            yield {
                "type": "requester_snapshot",
                "brokers": [
                    {
                        "id": broker["id"],
                        "name": broker["name"],
                        "service": broker["service"],
                        "price": broker["price"],
                        "reputation": broker["reputation"],
                    }
                    for broker in state
                ],
            }
            yield {
                "type": "a2a_assessment_started",
                "service": profile.service,
                "complexity": profile.complexity,
                "count": len(matching),
            }
            prompt = (
                f"Task: {task}\nRequired service: {profile.service}\nComplexity: {profile.complexity}\n"
                f"Normalized input: {profile.normalized_input}\nAssess how suitable you are for this task."
            )
            assessments = await asyncio.gather(
                *[
                    get_broker_assessment(f"http://127.0.0.1:{port_map[broker['id']]}", prompt)
                    for broker in matching
                ]
            )
            assessment_payload = [assessment.model_dump() for assessment in assessments]
            yield {"type": "a2a_assessment_results", "assessments": assessment_payload}
            choice_prompt = (
                f"Task: {task}\nService: {profile.service}\nComplexity: {profile.complexity}\n"
                f"Candidates:\n{json.dumps(assessment_payload, indent=2)}\n"
                f"Current reputations:\n{json.dumps([{b['id']: b['reputation']} for b in matching], indent=2)}"
            )
            choice = (await requester_agent.run(choice_prompt)).output
            chosen = next(broker for broker in state if broker["id"] == choice.broker_id)
            yield {
                "type": "a2a_decision",
                "brokerId": chosen["id"],
                "brokerName": chosen["name"],
                "reason": choice.reason,
            }
            yield {
                "type": "broker_selected",
                "brokerId": chosen["id"],
                "brokerName": chosen["name"],
                "service": chosen["service"],
                "input": profile.normalized_input,
            }

            paid = run_json("npx", "tsx", "scripts/pay-broker-json.ts", chosen["id"], profile.normalized_input)
            paid_data = paid["paid"]["data"]
            yield {
                "type": "broker_response",
                "brokerId": chosen["id"],
                "brokerName": chosen["name"],
                "service": chosen["service"],
                "payer": paid_data["payment"]["payer"],
                "amount": paid_data["payment"]["amount"],
                "network": paid_data["payment"]["network"],
                "outputPreview": paid_data["result"]["output"],
            }

            judge = (
                await judge_agent.run(
                    f"Service type: {chosen['service']}\nTask: {task}\nBroker output: {paid_data['result']['output']}"
                )
            ).output
            yield {"type": "judge_score", "brokerId": chosen["id"], "quality": judge.quality, "reason": judge.reason}

            feedback = run_json("npx", "tsx", "scripts/give-feedback-json.ts", chosen["id"], str(judge.quality))
            yield {
                "type": "feedback_written",
                "brokerId": chosen["id"],
                "txHash": feedback["txHash"],
                "quality": judge.quality,
            }

            latency_ms = int((time.time() - task_started) * 1000)
            price_usd = float(chosen["price"].replace("$", ""))
            completed += 1
            total_spent += price_usd
            latencies.append(latency_ms)
            picks[chosen["id"]] = picks.get(chosen["id"], 0) + 1
            yield {
                "type": "task_completed",
                "index": index,
                "total": len(tasks),
                "brokerId": chosen["id"],
                "priceUsd": price_usd,
                "judgeScore": judge.quality,
                "latencyMs": latency_ms,
            }

        yield {
            "type": "run_summary",
            "completed": completed,
            "total": len(tasks),
            "totalUsdcSpent": total_spent,
            "avgLatencyMs": round(sum(latencies) / max(1, len(latencies))),
            "picks": picks,
        }
    finally:
        stop_processes(procs)


async def fifty_events(total: int, requested_concurrency: int | None = None) -> AsyncIterator[dict[str, Any]]:
    load_env()
    count = max(1, total)
    concurrency = bounded_fifty_concurrency(count, requested_concurrency)
    run_id = f"web-a2a-fifty-{int(time.time() * 1000)}"
    ports = [free_port() for _ in range(concurrency)]
    env = load_env()
    procs = [
        subprocess.Popen(
            [sys.executable, "-m", "backend.fast_pay_sidecar", "--broker-id", "A", "--port", str(port)],
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        for port in ports
    ]
    try:
        base_urls = [f"http://127.0.0.1:{port}" for port in ports]
        await asyncio.gather(
            *[wait_for_a2a(base_url, proc) for base_url, proc in zip(base_urls, procs, strict=True)]
        )
        buyer = env.get("CIRCLE_WALLET_ADDRESS", "unknown")
        seller_url = f"{concurrency} A2A fast-pay workers -> broker A /service-fast"
        yield {
            "type": "fifty_started",
            "runId": run_id,
            "total": count,
            "concurrency": concurrency,
            "sellerUrl": seller_url,
            "buyer": buyer,
            "buyerUrl": f"{EXPLORER}/address/{buyer}",
        }

        clients = [A2AClient(base_url) for base_url in base_urls]
        results: list[dict[str, Any]] = []
        started = time.time()
        try:
            index_queue: asyncio.Queue[int] = asyncio.Queue()
            result_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            for index in range(1, count + 1):
                index_queue.put_nowait(index)

            async def run_one(index: int, client: A2AClient) -> None:
                tx_started = time.time()
                try:
                    response = await client.send_message(
                        {
                            "role": "user",
                            "kind": "message",
                            "message_id": str(uuid.uuid4()),
                            "parts": [{"kind": "text", "text": "settle one proof transaction"}],
                        }
                    )
                    result_task = await poll_a2a_result(client, response["result"]["id"])
                    result = result_task["result"]["artifacts"][0]["parts"][0]["data"]["result"]
                    proof_tx_hash = ""
                    if result["ok"]:
                        proof = await asyncio.to_thread(
                            run_json, "npx", "tsx", "scripts/give-feedback-json.ts", "A", "1"
                        )
                        proof_tx_hash = proof["txHash"]
                    dur_ms = round((time.time() - tx_started) * 1000)
                    record = {"index": index, **result, "dur_ms": dur_ms, "proof_tx_hash": proof_tx_hash}
                    await result_queue.put(
                        {
                            "record": record,
                            "event": {
                                "type": "tx_progress",
                                "txIndex": index,
                                "total": count,
                                "status": result["status"],
                                "durMs": dur_ms,
                                "ok": result["ok"] and bool(proof_tx_hash),
                                "proofTxHash": proof_tx_hash,
                            },
                        }
                    )
                except Exception as error:
                    dur_ms = round((time.time() - tx_started) * 1000)
                    record = {
                        "index": index,
                        "status": 0,
                        "dur_ms": dur_ms,
                        "ok": False,
                        "proof_tx_hash": "",
                        "note": str(error),
                    }
                    await result_queue.put(
                        {
                            "record": record,
                            "event": {
                                "type": "tx_progress",
                                "txIndex": index,
                                "total": count,
                                "status": 0,
                                "durMs": dur_ms,
                                "ok": False,
                                "note": str(error),
                            },
                        }
                    )

            async def worker(worker_id: int) -> None:
                client = clients[worker_id]
                while True:
                    try:
                        index = index_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        return
                    try:
                        await run_one(index, client)
                    finally:
                        index_queue.task_done()

            workers = [asyncio.create_task(worker(worker_id)) for worker_id in range(concurrency)]
            try:
                for completed in range(1, count + 1):
                    item = await result_queue.get()
                    results.append(item["record"])
                    event = item["event"]
                    event["index"] = completed
                    yield event
                await index_queue.join()
            finally:
                for worker_task in workers:
                    if not worker_task.done():
                        worker_task.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
        finally:
            await asyncio.gather(*[client.http_client.aclose() for client in clients], return_exceptions=True)

        results.sort(key=lambda result: result["index"])
        ok_count = sum(1 for result in results if result["ok"])
        avg = round(sum(result["dur_ms"] for result in results if result["ok"]) / max(1, ok_count))
        total_spent = ok_count * 0.003
        proof_tx_hashes = [result["proof_tx_hash"] for result in results if result.get("proof_tx_hash")]
        total_wall_ms = round((time.time() - started) * 1000)
        buyer_url = f"{EXPLORER}/address/{buyer}"
        receipt = write_receipt(
            f"{run_id}.json",
            {
                "summary": {
                    "runId": run_id,
                    "requirement": "50+ sub-cent on-chain payment proof",
                    "proofNote": "Arcscan address page is a general buyer activity page; use this receipt timestamp and tx count to identify this run.",
                    "concurrency": concurrency,
                    "okCount": ok_count,
                    "total": count,
                    "totalWallMs": total_wall_ms,
                    "avgLatencyMs": avg,
                    "totalUsdcSpent": total_spent,
                    "onchainProofCount": len(proof_tx_hashes),
                    "proofTxHashes": proof_tx_hashes,
                    "proofTxUrls": [f"{EXPLORER}/tx/{tx_hash}" for tx_hash in proof_tx_hashes],
                    "buyer": buyer,
                    "buyerUrl": buyer_url,
                    "sellerUrl": seller_url,
                    "createdAt": datetime.now(UTC).isoformat(),
                },
                "results": results,
            },
        )
        yield {
            "type": "fifty_summary",
            "runId": run_id,
            "concurrency": concurrency,
            "okCount": ok_count,
            "total": count,
            "totalWallMs": total_wall_ms,
            "avgLatencyMs": avg,
            "totalUsdcSpent": total_spent,
            "onchainProofCount": len(proof_tx_hashes),
            "proofTxHashes": proof_tx_hashes,
            "buyer": buyer,
            "buyerUrl": buyer_url,
            "receipt": receipt,
        }
    finally:
        stop_processes(procs)


async def stream_events(events: AsyncIterator[dict[str, Any]]) -> AsyncIterator[str]:
    try:
        async for event in events:
            yield sse(event)
        yield sse({"type": "done"})
    except Exception as error:
        yield sse({"type": "error", "message": str(error)})


@app.get("/health")
def health() -> dict[str, str]:
    return {"ok": "true"}


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "Arc A2A Backend", "health": "/health"}


@app.on_event("startup")
async def startup() -> None:
    await ensure_seller_server()


@app.on_event("shutdown")
def shutdown() -> None:
    stop_seller_server()


@app.get("/demo/run")
def run_demo(tasks: int = Query(default=1, ge=1)) -> StreamingResponse:
    return StreamingResponse(stream_events(demo_events(tasks)), media_type="text/event-stream")


@app.get("/fifty/run")
def run_fifty(
    total: int = Query(default=50, ge=1),
    concurrency: int = Query(default=0, ge=0, le=MAX_FIFTY_CONCURRENCY),
) -> StreamingResponse:
    requested = concurrency if concurrency > 0 else None
    return StreamingResponse(stream_events(fifty_events(total, requested)), media_type="text/event-stream")
