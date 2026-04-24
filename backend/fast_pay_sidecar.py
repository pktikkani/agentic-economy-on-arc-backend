from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fasta2a import FastA2A
from fasta2a.broker import InMemoryBroker
from fasta2a.schema import Artifact, DataPart, Message, TaskIdParams, TaskSendParams
from fasta2a.storage import InMemoryStorage
from fasta2a.worker import Worker


@dataclass
class FastPayWorker(Worker[None]):
    repo_root: Path = field(default_factory=Path.cwd)
    broker_id: str = "A"

    async def run_task(self, params: TaskSendParams) -> None:
        task = await self.storage.load_task(params["id"])
        if task is None:
            raise ValueError(f"Task {params['id']} not found")
        if task["status"]["state"] != "submitted":
            raise ValueError(f"Task {params['id']} already processed")

        await self.storage.update_task(task["id"], state="working")
        started = asyncio.get_running_loop().time()
        try:
            proc = await asyncio.create_subprocess_exec(
                "npx",
                "tsx",
                "scripts/pay-broker-fast-json.ts",
                self.broker_id,
                cwd=str(self.repo_root),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(stderr.decode() or stdout.decode() or "fast pay failed")
            payload = json.loads(stdout.decode())
            paid = payload["paid"]
            result = {
                "status": paid["status"],
                "ok": paid["status"] == 200,
                "dur_ms": round((asyncio.get_running_loop().time() - started) * 1000),
                "broker_id": payload["brokerId"],
                "broker_name": payload["brokerName"],
                "service": payload["service"],
                "price": payload["price"],
                "payment": paid["data"]["payment"],
            }
            await self.storage.update_task(task["id"], state="completed", new_artifacts=self.build_artifacts(result))
        except Exception:
            await self.storage.update_task(task["id"], state="failed")
            raise

    async def cancel_task(self, params: TaskIdParams) -> None:
        await self.storage.update_task(params["id"], state="canceled")

    def build_message_history(self, history: list[Message]) -> list[Any]:
        return []

    def build_artifacts(self, result: Any) -> list[Artifact]:
        return [
            Artifact(
                artifact_id=str(uuid.uuid4()),
                name="result",
                parts=[
                    DataPart(
                        kind="data",
                        data={"result": result},
                        metadata={"json_schema": {"type": "object"}},
                    )
                ],
            )
        ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--broker-id", default="A")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    storage = InMemoryStorage()
    broker = InMemoryBroker()
    worker = FastPayWorker(broker=broker, storage=storage, repo_root=repo_root, broker_id=args.broker_id)

    @asynccontextmanager
    async def lifespan(app: FastA2A):
        async with app.task_manager:
            async with worker.run():
                yield

    app = FastA2A(
        storage=storage,
        broker=broker,
        name="Arc Fast Pay Proof",
        url=f"http://127.0.0.1:{args.port}",
        description="A2A wrapper for the broker A service-fast payment proof path",
        lifespan=lifespan,
    )

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
