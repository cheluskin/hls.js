#!/usr/bin/env python3
"""Debug test - capture console logs to understand what's happening"""

from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # Capture ALL console logs
    def handle_console(msg):
        text = msg.text
        # Filter for relevant logs
        if any(x in text for x in ['FailbackLoader', 'fLoader', 'failback', 'ERROR', 'BLOCKED']):
            print(f"[{msg.type}] {text[:500]}")

    page.on('console', handle_console)

    print("Opening RKN test page...")
    page.goto('http://localhost:8080/demo/rkn-test.html')
    page.wait_for_load_state('networkidle')

    # Enable "all blocked" mode
    print("\n=== Test with ALL BLOCKED + 403 mode ===")
    page.check('#all-blocked')
    time.sleep(0.3)

    # Click Start Test
    page.click('#btn-start')

    # Wait a bit for logs
    print("Waiting 10s for logs...")
    time.sleep(10)

    # Get stats
    direct = page.locator('#stat-direct').text_content()
    failback = page.locator('#stat-failback').text_content()
    blocked = page.locator('#stat-blocked').text_content()
    errors = page.locator('#stat-errors').text_content()

    print(f"\n=== Stats ===")
    print(f"Direct: {direct}, Failback: {failback}, Blocked: {blocked}, Errors: {errors}")

    page.screenshot(path='/tmp/debug-test.png', full_page=True)
    print("\nScreenshot saved to /tmp/debug-test.png")

    browser.close()
