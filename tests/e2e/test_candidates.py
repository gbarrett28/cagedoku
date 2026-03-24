"""Playwright e2e tests for the candidates view.

Tests upload → confirm flow and UI interaction (button visibility, toggles,
keyboard routing, help modal). Canvas pixel/colour assertions are excluded.

All tests share a session via module-scoped page state where possible.
Network request interception is used to verify which API endpoints are called.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from playwright.sync_api import Page, expect


def _upload_and_confirm(
    page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
) -> None:
    """Upload the mock puzzle and click confirm — shared setup helper."""

    page.goto(live_server_url)

    # Write bytes to a temp file so Playwright can set_input_files
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(tiny_jpeg_bytes)
        upload_path = Path(tmp.name)

    try:
        # Set the file directly on the file input
        page.locator("#file-input").set_input_files(str(upload_path))

        # Process
        with page.expect_response("**/api/puzzle**") as resp_info:
            page.click("#process-btn")
        resp_info.value.finished()

        # Confirm
        with page.expect_response("**/confirm") as resp_info:
            page.click("#confirm-btn")
        resp_info.value.finished()
    finally:
        upload_path.unlink(missing_ok=True)


class TestUploadConfirmFlow:
    def test_canvas_visible_after_confirm(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        expect(page.locator("#grid-canvas")).to_be_visible()

    def test_candidates_btn_enabled_after_confirm(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        expect(page.locator("#candidates-btn")).to_be_enabled()


class TestCandidatesToggle:
    def test_show_hide_toggle(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        btn = page.locator("#candidates-btn")
        expect(btn).to_have_text("Show candidates")
        btn.click()
        expect(btn).to_have_text("Hide candidates")
        btn.click()
        expect(btn).to_have_text("Show candidates")

    def test_edit_btn_appears_when_candidates_shown(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        expect(page.locator("#edit-candidates-btn")).to_be_hidden()
        page.click("#candidates-btn")
        expect(page.locator("#edit-candidates-btn")).to_be_visible()

    def test_mode_btn_appears_when_candidates_shown(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        page.click("#candidates-btn")
        expect(page.locator("#candidates-mode-btn")).to_be_visible()

    def test_help_btn_appears_when_candidates_shown(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        page.click("#candidates-btn")
        expect(page.locator("#help-candidates-btn")).to_be_visible()


class TestKeyboardRouting:
    def test_digit_in_solution_entry_mode_calls_cell_endpoint(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        # Select cell (1,1) by clicking top-left area of canvas
        canvas = page.locator("#grid-canvas")
        canvas.click(position={"x": 30, "y": 30})  # MARGIN + ~0.5*CELL

        requests: list[str] = []
        page.on("request", lambda r: requests.append(r.url))

        page.keyboard.press("5")
        page.wait_for_timeout(300)

        cell_calls = [u for u in requests if "/cell" in u and "/candidates" not in u]
        candidate_calls = [u for u in requests if "/candidates/cell" in u]
        assert len(cell_calls) >= 1, (
            "Expected /cell to be called in solution entry mode"
        )
        assert len(candidate_calls) == 0, "Expected no /candidates/cell call"

    def test_digit_in_candidate_edit_mode_calls_candidates_endpoint(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        page.click("#candidates-btn")
        page.click("#edit-candidates-btn")

        canvas = page.locator("#grid-canvas")
        canvas.click(position={"x": 30, "y": 30})

        requests: list[str] = []
        page.on("request", lambda r: requests.append(r.url))

        page.keyboard.press("5")
        page.wait_for_timeout(300)

        candidate_calls = [u for u in requests if "/candidates/cell" in u]
        # Filter for the solution-entry /cell endpoint only (not /candidates/cell)
        cell_calls = [
            u for u in requests if u.endswith("/cell") and "/candidates" not in u
        ]
        assert len(candidate_calls) >= 1, "Expected /candidates/cell to be called"
        assert len(cell_calls) == 0, "Expected no /cell call in candidate edit mode"


class TestModeToggle:
    def test_mode_btn_label_changes(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        page.click("#candidates-btn")
        btn = page.locator("#candidates-mode-btn")
        expect(btn).to_have_text("Auto")
        with page.expect_response("**/candidates/mode"):
            btn.click()
        expect(btn).to_have_text("Manual")


class TestHelpModal:
    def test_help_modal_opens_and_closes(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        page.click("#candidates-btn")
        page.click("#help-candidates-btn")
        expect(page.locator("#help-candidates-modal")).to_be_visible()
        page.click("#close-help-btn")
        expect(page.locator("#help-candidates-modal")).to_be_hidden()
