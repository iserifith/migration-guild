from playwright.sync_api import sync_playwright
import time

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('http://localhost:5173')

        # intercept and delay network to show loading state
        def delay_route(route):
            time.sleep(1)
            route.continue_()

        page.route("**/api/registry/status", delay_route)

        # Trigger refresh
        page.click('button:has-text("refresh")')
        page.wait_for_timeout(100)

        page.screenshot(path='screenshot.png')
        browser.close()

if __name__ == '__main__':
    main()
