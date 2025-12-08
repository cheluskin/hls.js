#!/usr/bin/env python3
"""Test RKN blocking simulator with Playwright"""

from playwright.sync_api import sync_playwright
import time
import sys

# Parse args: --all-blocked to enable all segments blocked mode
all_blocked = '--all-blocked' in sys.argv

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # Capture console logs
    logs = []
    page.on('console', lambda msg: logs.append(f"[{msg.type}] {msg.text}"))

    print("Opening RKN test page...")
    page.goto('http://localhost:8080/demo/rkn-test.html')
    page.wait_for_load_state('networkidle')

    # Take initial screenshot
    page.screenshot(path='/tmp/rkn-test-1-initial.png', full_page=True)
    print("Initial screenshot saved to /tmp/rkn-test-1-initial.png")

    # Check if blocking server is connected
    server_status = page.locator('#sw-status').text_content()
    print(f"Server status: {server_status}")

    # Enable "all blocked" mode if requested
    if all_blocked:
        print("\n=== ENABLING 'ALL BLOCKED' MODE ===")
        page.check('#all-blocked')
        time.sleep(0.5)

    # Click Start Test button
    print("Clicking Start Test...")
    page.click('#btn-start')

    # Wait for some segments to load (with failback)
    wait_time = 20 if all_blocked else 15
    print(f"Waiting {wait_time}s for segments to load...")
    time.sleep(wait_time)

    # Take screenshot after test
    page.screenshot(path='/tmp/rkn-test-2-after.png', full_page=True)
    print("After screenshot saved to /tmp/rkn-test-2-after.png")

    # Get log entries
    log_entries = page.locator('#logs .log-entry').all()
    print(f"\n=== Log Entries ({len(log_entries)}) ===")
    for entry in log_entries[:25]:  # First 25 entries
        text = entry.text_content()
        print(text[:200] if len(text) > 200 else text)

    # Check for failback URLs
    print("\n=== Checking for failback URLs ===")
    failback_entries = page.locator('.log-failback, .log-blocked').all()
    for entry in failback_entries:
        url_el = entry.locator('.log-url')
        if url_el.count() > 0:
            url = url_el.text_content()
            print(f"Failback URL: {url}")
            if 'test-streams.mux.dev' in url:
                print("  ✓ CORRECT: Uses test-streams.mux.dev")
            elif 'localhost:8081' in url:
                print("  ✗ WRONG: Still using localhost:8081")

    # Get stats
    direct = page.locator('#stat-direct').text_content()
    failback = page.locator('#stat-failback').text_content()
    blocked = page.locator('#stat-blocked').text_content()
    errors = page.locator('#stat-errors').text_content()
    print(f"\n=== Stats ===")
    print(f"Direct: {direct}, Failback: {failback}, Blocked: {blocked}, Errors: {errors}")

    # In all-blocked mode, verify ALL successes came via failback
    if all_blocked:
        if int(direct) == 0 and int(failback) > 0:
            print("\n✓ ALL BLOCKED MODE WORKS: All segments used failback")
        else:
            print(f"\n✗ PROBLEM: Direct={direct}, should be 0 in all-blocked mode")

    browser.close()
    print("\nTest complete!")
