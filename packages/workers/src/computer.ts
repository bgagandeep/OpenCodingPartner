export interface ComputerAction {
  id: string;
  kind: "open-url" | "type" | "read-screen";
  target: string;
  purpose: string;
  /** Always false in the offline stub. A live browser did not run. */
  executed: false;
  liveBrowser: false;
}

export interface GtmPlan {
  title: string;
  note: string;
  actions: ComputerAction[];
}

/** Record intended go-to-market computer actions. Nothing here is executed. */
export function planGtmActions(productName: string): GtmPlan {
  return {
    title: `${productName} go-to-market`,
    note: "Recorded intended computer actions. No live browser ran.",
    actions: [
      {
        id: "gtm-1",
        kind: "open-url",
        target: "https://example.invalid/draft-landing",
        purpose: "Open the draft landing page",
        executed: false,
        liveBrowser: false,
      },
      {
        id: "gtm-2",
        kind: "type",
        target: "hero",
        purpose: "Draft a one-line pitch",
        executed: false,
        liveBrowser: false,
      },
      {
        id: "gtm-3",
        kind: "read-screen",
        target: "hero",
        purpose: "Check the pitch is visible",
        executed: false,
        liveBrowser: false,
      },
    ],
  };
}
