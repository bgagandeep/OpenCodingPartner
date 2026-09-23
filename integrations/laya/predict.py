#!/usr/bin/env python3
"""Operator-run bridge to the real Laya router.

OpenCodingPartner does not import this module and does not spawn it during
the offline demo. Run it only after installing the upstream package::

    python -m pip install laya
    python integrations/laya/predict.py

Stdin is a JSON object ``{"state", "questions", "model"}``. Stdout is the
object returned by ``Router.predict``. The first call can download weights
from the Hugging Face Hub into the operator's cache. This repository does
not bundle those weights and does not call a hosted Laya endpoint.

Upstream, independent of this project:

- package: https://pypi.org/project/laya/  (0.3.7, Apache-2.0)
- English checkpoint: https://huggingface.co/convaiinnovations/laya
  (ModernBERT-large, about 421M parameters)
"""

from __future__ import annotations

import json
import sys


def main() -> None:
    try:
        from laya import Router
    except ImportError as exc:
        raise SystemExit(
            "The laya package is not installed. "
            "Install it in this environment with: python -m pip install laya"
        ) from exc

    payload = json.load(sys.stdin)
    state = payload["state"]
    questions = payload["questions"]
    model = payload.get("model") or "english"
    router = Router()
    result = router.predict(state, questions, model=model)
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
