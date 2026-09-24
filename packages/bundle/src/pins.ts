import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface StackPins {
  openclaw: {
    npm: string;
    version: string;
    license: string;
    credit: string;
    url: string;
    image: string;
  };
  grokBuild: {
    npm: string;
    version: string;
    license: string;
    credit: string;
    url: string;
    docs: string;
  };
  laya: {
    pypi: string;
    version: string;
    license: string;
    credit: string;
    url: string;
    weights: string;
    checkpoint: string;
    weightNote: string;
  };
}

export function pinsPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../pins.json");
}

export function loadPins(): StackPins {
  return JSON.parse(readFileSync(pinsPath(), "utf8")) as StackPins;
}
