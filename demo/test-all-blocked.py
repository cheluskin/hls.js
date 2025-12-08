#!/usr/bin/env python3
"""Test RKN blocking simulator with ALL BLOCKED mode"""

from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # Capture console logs
    logs = []
    page.on('console', lambda msg: logs.append(f"[{msg.type}] {msg.text}"))

    print("Opening RKN test page...")
    page.goto('http://localhost:8080/demo/rkn-test.html')
    page.wait_for_load_state('networkidle')

    # Check if blocking server is connected
    server_status = page.locator('#sw-status').text_content()
    print(f"Server status: {server_status}")

    # Enable "all blocked" mode
    print("\n=== ENABLING 'ALL BLOCKED' MODE ===")
    page.check('#all-blocked')
    time.sleep(0.5)

    # Verify checkbox is checked
    is_checked = page.locator('#all-blocked').is_checked()
    print(f"All blocked checkbox checked: {is_checked}")

    # Click Start Test button
    print("\nClicking Start Test...")
    page.click('#btn-start')

    # Wait for segments to load (all need failback)
    print("Waiting 25s for segments to load with failback...")
    time.sleep(25)

    # Take screenshot
    page.screenshot(path='/tmp/rkn-all-blocked.png', full_page=True)
    print("Screenshot saved to /tmp/rkn-all-blocked.png")

    # Get log entries
    log_entries = page.locator('#logs .log-entry').all()
    print(f"\n=== Log Entries ({len(log_entries)}) ===")
    for entry in log_entries[:30]:
        text = entry.text_content()
        print(text[:200] if len(text) > 200 else text)

    # Get stats
    direct = page.locator('#stat-direct').text_content()
    failback = page.locator('#stat-failback').text_content()
    blocked = page.locator('#stat-blocked').text_content()
    errors = page.locator('#stat-errors').text_content()

    print(f"\n=== Stats ===")
    print(f"Direct: {direct}, Failback: {failback}, Blocked: {blocked}, Errors: {errors}")

    # Verify ALL BLOCKED mode works
    print(f"\n=== Verification ===")
    if int(direct) == 0 and int(failback) > 0:
        print("SUCCESS: All segments used failback (Direct=0)")
    elif int(direct) > 0:
        print(f"PROBLEM: Direct={direct} should be 0 in all-blocked mode")
    else:
        print("WAITING: No segments loaded yet")

    browser.close()
    print("\nTest complete!")
