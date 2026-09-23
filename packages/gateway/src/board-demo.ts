export const BOARD_DEMO_FILE = {
  relativePath: "BOARD.md",
  contents: [
    "OpenCodingPartner foundation is ready for Board review.",
    "The local sandbox worker wrote this file after the policy router selected the coding manager.",
    "Speculative swarm stayed off. One worker ran.",
    "",
  ].join("\n"),
} as const;

export const BOARD_DEMO_MESSAGES = {
  status: "Summarize the mesh status for Board review. Do not edit files.",
  write: `create ${BOARD_DEMO_FILE.relativePath} with content:\n${BOARD_DEMO_FILE.contents}`,
} as const;

export const BOARD_DEMO_KEYS = {
  status: "board-demo:status",
  write: "board-demo:write",
} as const;
