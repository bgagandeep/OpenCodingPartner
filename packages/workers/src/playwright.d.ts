declare module "playwright" {
  interface PlaywrightPage {
    goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
    title(): Promise<string>;
    screenshot(options?: { type?: "png" }): Promise<Buffer>;
  }
  interface PlaywrightBrowser {
    newPage(): Promise<PlaywrightPage>;
    close(): Promise<void>;
  }
  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser>;
  };
}
