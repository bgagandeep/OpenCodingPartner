declare module "playwright" {
  interface PlaywrightLocator {
    fill(text: string, options?: { timeout?: number }): Promise<void>;
    innerText(options?: { timeout?: number }): Promise<string>;
    isVisible(options?: { timeout?: number }): Promise<boolean>;
    inputValue(options?: { timeout?: number }): Promise<string>;
  }
  interface PlaywrightPage {
    goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
    title(): Promise<string>;
    screenshot(options?: { type?: "png" }): Promise<Buffer>;
    locator(selector: string): PlaywrightLocator;
  }
  interface PlaywrightBrowser {
    newPage(): Promise<PlaywrightPage>;
    close(): Promise<void>;
  }
  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser>;
  };
}
