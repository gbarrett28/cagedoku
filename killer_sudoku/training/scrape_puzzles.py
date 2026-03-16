"""Guardian/Observer killer sudoku puzzle image scraper.

Downloads puzzle images from the Guardian website. The website structure may
have changed since this scraper was written -- treat existing .jpg images as
the primary source of training data and only use this as a last resort.

The scraper iterates over the Guardian series index pages, collects article
links for Guardian and Observer killer sudokus, then for each article fetches
the print-edition .jpg image. Images are named killer_sudoku_N.jpg and saved
into the appropriate output directory.

Usage:
    python -m killer_sudoku.training.scrape_puzzles --output-dir guardian
    python -m killer_sudoku.training.scrape_puzzles --output-dir observer
"""

import argparse
import logging
import re
from pathlib import Path

import requests  # type: ignore[import-untyped]
from bs4 import BeautifulSoup, Tag

_log = logging.getLogger(__name__)


def scrape_puzzles(output_dir: Path) -> None:
    """Download killer sudoku puzzle images into output_dir.

    Fetches the Guardian series index pages, collects article URLs for the
    matching newspaper (Guardian or Observer, determined by whether "bserver"
    appears in the URL), then downloads the print .jpg from each article.

    Only runs if output_dir does not already exist. This is intentional:
    the existing .jpg images are the primary source of training data and
    should not be overwritten.

    WARNING: The Guardian website structure may have changed since this was
    written. If downloads fail, inspect the page source and update the
    BeautifulSoup selectors accordingly.

    Args:
        output_dir: Directory to create and populate with .jpg files.
            Named "observer" or "guardian" by convention.
    """
    html_idx = "https://www.theguardian.com/lifeandstyle/series/killer-sudoku?page={}"

    # Determine which newspaper to collect based on directory name.
    is_observer = output_dir.name.lower() == "observer"

    article_urls: set[str] = set()
    prev_count = 0

    for i in range(1024):
        url = html_idx.format(i + 1)
        r = requests.get(url, timeout=30)
        if r.status_code != 200:
            _log.info("Index page %s returned %d, stopping.", url, r.status_code)
            break

        soup = BeautifulSoup(r.text, "html.parser")
        for link in soup.find_all("a", attrs={"class": "fc-item__link"}):
            if not isinstance(link, Tag):
                continue
            href = link.get("href")
            if not isinstance(href, str):
                continue
            if is_observer and "bserver" in href:
                article_urls.add(href)
            elif not is_observer and "bserver" not in href:
                article_urls.add(href)

        if len(article_urls) == prev_count:
            _log.info("No new URLs found on page %d, stopping.", i + 1)
            break
        prev_count = len(article_urls)
        _log.info("Found %d article URLs so far...", len(article_urls))

    _log.info("Total article URLs: %d", len(article_urls))

    if output_dir.exists():
        _log.info(
            "%s already exists -- skipping download to preserve existing images.",
            output_dir,
        )
        return

    output_dir.mkdir(parents=True)
    print_link_pattern = re.compile(r"uploads\.guim\.co\.uk.*\.jpg$")
    obs = 0

    for article_url in sorted(article_urls):
        puzzle_req = requests.get(article_url, timeout=30)
        if puzzle_req.status_code != 200:
            _log.warning(
                "Failed to fetch article %s (status %d)",
                article_url,
                puzzle_req.status_code,
            )
            continue

        puzzle_page = BeautifulSoup(puzzle_req.text, "html.parser")
        for jpg in puzzle_page.find_all("a", href=print_link_pattern):
            if not isinstance(jpg, Tag):
                continue
            raw_url = jpg.get("href")
            if not isinstance(raw_url, str):
                continue
            jpg_url: str = raw_url
            puzzle_jpg = output_dir / f"killer_sudoku_{obs}.jpg"
            _log.info("Scraping %s from %s", puzzle_jpg, jpg_url)
            jpg_resp = requests.get(jpg_url, timeout=30)
            puzzle_jpg.write_bytes(jpg_resp.content)
            obs += 1

    _log.info("Downloaded %d puzzle images to %s/", obs, output_dir)


def main() -> None:
    """CLI entry point: scrape puzzle images from the Guardian website."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Scrape Guardian/Observer killer sudoku puzzle images"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help='Directory to save images into (e.g. "guardian" or "observer")',
    )
    args = parser.parse_args()
    scrape_puzzles(args.output_dir)


if __name__ == "__main__":
    main()
