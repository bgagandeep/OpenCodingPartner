/**
 * OpenClaw plugin. The gateway calls ocp_sandbox_write. This file posts to the
 * local write bridge. It does not write the sandbox itself and it does not call fs_write.
 * Live load is operator-specific. See README "Live OpenClaw write".
 */
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
      const response = await fetch(args.bridgeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relativePath: args.relativePath, content: args.content }),
      });
      const body = await response.json();
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    },
  });
}
