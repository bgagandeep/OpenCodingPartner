declare module "playwright" {
  interface PlaywrightLocator {
    fill(text: string, options?: { timeout?: number }): Promise<void>;
    innerText(options?: { timeout?: number }): Promise<string>;
    isVisible(options?: { timeout?: number }): Promise<boolean>;
    inputValue(options?: { timeout?: number }): Promise<string>;
    click(options?: { timeout?: number }): Promise<void>;
    waitFor(options?: { state?: "visible" | "attached"; timeout?: number }): Promise<void>;
    scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  }
  interface PlaywrightPage {
    goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
    title(): Promise<string>;
    screenshot(options?: { type?: "png" }): Promise<Buffer>;
    locator(selector: string): PlaywrightLocator;
    getByText(text: string, options?: { exact?: boolean }): PlaywrightLocator;
    mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  }
  interface PlaywrightBrowser {
    newPage(): Promise<PlaywrightPage>;
    close(): Promise<void>;
  }
  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser>;
  };
}
