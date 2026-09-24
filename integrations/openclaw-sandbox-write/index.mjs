/**
 * OpenClaw plugin. The gateway calls these tools. Each one posts to the
 * local write bridge. This file does not touch the sandbox and it does not call fs_write.
 * Live load is operator-specific. See README "Live OpenClaw write".
 */
async function postBridge(bridgeUrl, payload) {
  const response = await fetch(bridgeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

export default function register(api) {
  api.registerTool({
    name: "ocp_sandbox_write",
    description: "Write one sandbox file through the OpenCodingPartner write bridge.",
    parameters: {
      type: "object",
      properties: {
        bridgeUrl: { type: "string" },
        relativePath: { type: "string" },
        content: { type: "string" },
      },
      required: ["bridgeUrl", "relativePath", "content"],
    },
    async execute(_id, args) {
      return postBridge(args.bridgeUrl, { relativePath: args.relativePath, content: args.content });
    },
  });
  api.registerTool({
    name: "ocp_sandbox_delete",
    description: "Delete one sandbox file through the OpenCodingPartner write bridge.",
    parameters: {
      type: "object",
      properties: {
        bridgeUrl: { type: "string" },
        relativePath: { type: "string" },
      },
      required: ["bridgeUrl", "relativePath"],
    },
    async execute(_id, args) {
      return postBridge(args.bridgeUrl, { relativePath: args.relativePath });
    },
  });
  api.registerTool({
    name: "ocp_sandbox_rename",
    description: "Rename one sandbox file through the OpenCodingPartner write bridge.",
    parameters: {
      type: "object",
      properties: {
        bridgeUrl: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["bridgeUrl", "from", "to"],
    },
    async execute(_id, args) {
      return postBridge(args.bridgeUrl, { from: args.from, to: args.to });
    },
  });
}
