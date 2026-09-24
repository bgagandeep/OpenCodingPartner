"""Local bridge to an operator-installed Laya router.

The offline demo does not run this file. It does not download weights.
Install Laya yourself, then pipe JSON on stdin:

    {"state": "...", "questions": [...], "model": "english"}

Upstream: https://pypi.org/project/laya/ (Apache-2.0)
Weights: https://huggingface.co/convaiinnovations/laya
"""

import json
import sys


def main() -> None:
    payload = json.load(sys.stdin)
    state = payload.get("state", "")
    questions = payload.get("questions", [])
    model = payload.get("model") or "english"
    from laya import Router

    router = Router()
    answers = router.predict(state, questions, model=model)
    json.dump(answers, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
