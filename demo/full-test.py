#!/usr/bin/env python3
"""Full test - all blocked mode"""

from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # Count log types
    failback_logs = []
    success_logs = []

    def handle_console(msg):
        text = msg.text
        if 'FailbackLoader' in text and 'trying:' in text:
            failback_logs.append(text)
            print(f"FAILBACK: {text[text.find('trying:'):][:80]}")
        elif 'SUCCESS via failback' in text:
            success_logs.append(text)
            print(f"SUCCESS: via failback")
        elif 'SUCCESS (direct)' in text:
            print(f"DIRECT: success")

    page.on('console', handle_console)

    print("Opening RKN test page...")
    page.goto('http://localhost:8080/demo/rkn-test.html')
    page.wait_for_load_state('networkidle')

    # Enable "all blocked" mode
    print("\n=== Test: ALL BLOCKED + 403 mode ===\n")
    page.check('#all-blocked')
    time.sleep(0.3)

    # Click Start Test
    page.click('#btn-start')

    # Wait for all segments to load
    print("Loading segments...")
    time.sleep(30)

    # Get final stats
    direct = page.locator('#stat-direct').text_content()
    failback = page.locator('#stat-failback').text_content()
    blocked = page.locator('#stat-blocked').text_content()
    errors = page.locator('#stat-errors').text_content()

    print(f"\n=== FINAL STATS ===")
    print(f"Direct:   {direct}")
    print(f"Failback: {failback}")
    print(f"Blocked:  {blocked}")
    print(f"Errors:   {errors}")

    # Verify
    if int(direct) == 0 and int(failback) > 0 and int(errors) == 0:
        print(f"\nSUCCESS: All {failback} segments loaded via failback!")
    else:
        print(f"\nWARNING: Unexpected results")

    page.screenshot(path='/tmp/full-test.png', full_page=True)
    browser.close()
