from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import dotenv_values
from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.models.google import GoogleModelSettings


class BrokerAssessment(BaseModel):
    broker_id: str
    broker_name: str
    service: str
    fit_score: float
    reason: str


BROKERS = {
    "A": {"name": "FastSent", "service": "sentiment", "price": "$0.003", "quality": 0.65},
    "B": {"name": "DeepSent", "service": "sentiment", "price": "$0.008", "quality": 0.92},
    "C": {"name": "QuickPrice", "service": "price-lookup", "price": "$0.002", "quality": 0.70},
    "D": {"name": "SharpPrice", "service": "price-lookup", "price": "$0.007", "quality": 0.95},
    "E": {"name": "Summarizer", "service": "summarize", "price": "$0.005", "quality": 0.85},
}


def load_env() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    for key, value in dotenv_values(repo_root / ".env").items():
        if value is not None:
            os.environ.setdefault(key, value)
    if os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY"):
        os.environ["GOOGLE_API_KEY"] = os.environ["GOOGLE_GENERATIVE_AI_API_KEY"]
    os.environ.pop("GEMINI_API_KEY", None)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--broker-id", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    load_env()
    broker = BROKERS[args.broker_id]
    agent = Agent(
        "google-gla:gemini-3-flash-preview",
        output_type=BrokerAssessment,
        model_settings=GoogleModelSettings(google_thinking_config={"thinking_level": "low"}),
        instructions=(
            f"You are broker {args.broker_id} named {broker['name']}.\n"
            f"Your service is {broker['service']}.\n"
            f"Your price is {broker['price']}.\n"
            f"Your quality tier is {broker['quality']} on a 0 to 1 scale.\n"
            "You do not perform the paid task here. You only assess whether you are a good fit.\n"
            "If the requested service does not match your service, return fit_score=0.\n"
            "If it matches, rate your suitability from 0 to 1 and explain briefly.\n"
            f"Always return broker_id='{args.broker_id}', broker_name='{broker['name']}', service='{broker['service']}'."
        ),
    )
    app = agent.to_a2a(
        name=broker["name"],
        url=f"http://127.0.0.1:{args.port}",
        description=f"{broker['service']} broker assessment sidecar",
    )

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
