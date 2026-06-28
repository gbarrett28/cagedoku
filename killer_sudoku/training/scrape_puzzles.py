r"""Puzzle image scraper for Guardian/Observer newspaper series.

Downloads puzzle images from a newspaper series index page. The website
structure may have changed since this scraper was written -- treat existing
.jpg images as the primary source of training data and only use this as a
last resort.

The scraper iterates over the series index pages (most-recent-first), collects
article links, then for each article fetches the print-edition .jpg image.
Images are named killer_sudoku_N.jpg and saved into the output directory (or a
subdirectory named after the detected difficulty when --subdir-keywords is used).

Usage:
    # Killer sudoku (default)
    python -m killer_sudoku.training.scrape_puzzles --output-dir <dir>

    # Classic sudoku, 500 most-recent per difficulty
    python -m killer_sudoku.training.scrape_puzzles --output-dir <dir> \\
        --series-url "https://www.theguardian.com/lifeandstyle/series/sudoku?page={}" \\
        --subdir-keywords easy medium hard diabolical expert \\
        --max-per-subdir 500

    # Observer killer sudoku only
    python -m killer_sudoku.training.scrape_puzzles --output-dir <dir> \\
        --url-contains bserver
"""

import argparse
import logging
import re
from pathlib import Path

import requests  # type: ignore[import-untyped]
from bs4 import BeautifulSoup, Tag

_log = logging.getLogger(__name__)

_DEFAULT_SERIES = "https://www.theguardian.com/lifeandstyle/series/killer-sudoku?page={}"


def _detect_subdir(article_url: str, keywords: list[str]) -> str:
    """Return the first keyword found in article_url, or 'other' if none match.

    Keywords are checked in order; the first match wins.  Matching is
    case-insensitive against the URL path.

    Args:
        article_url: Full article URL, e.g. '.../sudoku-diabolical-no-4212'.
        keywords: Ordered list of difficulty keywords to detect.

    Returns:
        The matched keyword (lowercase), or 'other'.
    """
    lower = article_url.lower()
    for kw in keywords:
        if kw.lower() in lower:
            return kw.lower()
    return "other"


def scrape_puzzles(
    output_dir: Path,
    series_url: str = _DEFAULT_SERIES,
    url_contains: str | None = None,
    subdir_keywords: list[str] | None = None,
    max_per_subdir: int | None = None,
) -> None:
    """Download puzzle images into output_dir.

    Fetches the series index pages (most-recent-first), collects article URLs,
    then downloads the print .jpg from each article.

    When subdir_keywords is provided, each image is saved into a subdirectory
    of output_dir named after the first keyword found in the article URL
    (e.g. 'diabolical', 'hard').  Articles whose URL matches none of the
    keywords are saved into 'other/'.

    When max_per_subdir is provided alongside subdir_keywords, at most that
    many articles are collected per named keyword bucket.  Because the index
    pages are most-recent-first, collection stops for a bucket once it is full,
    so the downloaded images are the most-recent N for each difficulty.
    Collection stops entirely once every named bucket is full (articles in
    'other/' are unlimited regardless).

    Without subdir_keywords, all images are saved directly into output_dir
    and the directory guard applies to output_dir itself.

    If url_contains is provided, only articles whose URL contains that
    substring are collected.  On Windows/Git Bash, set MSYS_NO_PATHCONV=1
    before the command if the filter starts with '/' to prevent the shell
    rewriting the path.

    WARNING: The website structure may have changed since this was written.
    If downloads fail, inspect the page source and update the BeautifulSoup
    selectors accordingly.

    Args:
        output_dir: Root directory for downloaded images.
        series_url: Series index URL with ``{}`` as the page-number
            placeholder. Defaults to the Guardian killer-sudoku series.
        url_contains: Optional substring filter applied to article URLs.
            If None, all articles from the series index are collected.
        subdir_keywords: If given, save each image into a subdirectory of
            output_dir named after the first matching keyword in the article
            URL (case-insensitive). Non-matching articles go into 'other/'.
        max_per_subdir: If given (with subdir_keywords), collect at most this
            many articles per named keyword bucket, selecting the most recent.
            Has no effect without subdir_keywords.
    """
    html_idx = series_url

    article_urls: set[str] = set()
    # Per-keyword URL count — used to enforce max_per_subdir during collection.
    subdir_url_counts: dict[str, int] = {}
    prev_count = 0

    for i in range(1024):
        url = html_idx.format(i + 1)
        r = requests.get(url, timeout=30)
        if r.status_code != 200:
            _log.info("Index page %s returned %d, stopping.", url, r.status_code)
            break

        soup = BeautifulSoup(r.text, "html.parser")
        # Guardian DCR design uses data-link-name on article card anchors.
        # The legacy fc-item__link class was removed in the 2024 redesign.
        for link in (t for t in soup.find_all("a", attrs={"data-link-name": re.compile(r"^news \|")}) if isinstance(t, Tag)):
            href = link.get("href")
            if not isinstance(href, str):
                continue
            # Relative paths (e.g. /lifeandstyle/...) — make absolute.
            if href.startswith("/"):
                href = "https://www.theguardian.com" + href
            if url_contains is not None and url_contains not in href:
                continue
            # Enforce per-subdir cap during collection.  Because index pages are
            # most-recent-first, the first N articles added to each bucket are
            # the most recent N.
            if max_per_subdir is not None and subdir_keywords:
                bucket = _detect_subdir(href, subdir_keywords)
                if bucket != "other" and subdir_url_counts.get(bucket, 0) >= max_per_subdir:
                    continue
                subdir_url_counts[bucket] = subdir_url_counts.get(bucket, 0) + 1
            article_urls.add(href)

        if len(article_urls) == prev_count:
            _log.info("No new URLs found on page %d, stopping.", i + 1)
            break
        prev_count = len(article_urls)
        _log.info("Found %d article URLs so far...", len(article_urls))

        # Early exit: stop paginating once every named bucket is full.
        if max_per_subdir is not None and subdir_keywords:
            all_full = all(
                subdir_url_counts.get(kw, 0) >= max_per_subdir
                for kw in subdir_keywords
            )
            if all_full:
                _log.info(
                    "All %d subdir buckets have %d URLs — stopping early.",
                    len(subdir_keywords), max_per_subdir,
                )
                break

    _log.info("Total article URLs: %d", len(article_urls))
    if max_per_subdir is not None and subdir_keywords:
        for kw in subdir_keywords:
            _log.info("  %-12s %d URLs", kw, subdir_url_counts.get(kw, 0))

    # Without subdir_keywords: guard on output_dir itself.
    if not subdir_keywords:
        if output_dir.exists():
            _log.info(
                "%s already exists -- skipping download to preserve existing images.",
                output_dir,
            )
            return
        output_dir.mkdir(parents=True)

    print_link_pattern = re.compile(r"uploads\.guim\.co\.uk.*\.jpg$")

    # Track per-subdir image counts so numbering within each subdir is independent.
    subdir_img_counts: dict[str, int] = {}

    for article_url in sorted(article_urls):
        # Determine the target directory for this article.
        if subdir_keywords:
            subdir_name = _detect_subdir(article_url, subdir_keywords)
            target_dir = output_dir / subdir_name
            if not target_dir.exists():
                target_dir.mkdir(parents=True)
                _log.info("Created subdirectory %s", target_dir)
        else:
            target_dir = output_dir

        puzzle_req = requests.get(article_url, timeout=30)
        if puzzle_req.status_code != 200:
            _log.warning(
                "Failed to fetch article %s (status %d)",
                article_url,
                puzzle_req.status_code,
            )
            continue

        puzzle_page = BeautifulSoup(puzzle_req.text, "html.parser")
        for jpg in (t for t in puzzle_page.find_all("a", href=print_link_pattern) if isinstance(t, Tag)):
            raw_url = jpg.get("href")
            if not isinstance(raw_url, str):
                continue
            jpg_url: str = raw_url
            key = str(target_dir)
            obs = subdir_img_counts.get(key, 0)
            puzzle_jpg = target_dir / f"killer_sudoku_{obs}.jpg"
            _log.info("Scraping %s from %s", puzzle_jpg, jpg_url)
            jpg_resp = requests.get(jpg_url, timeout=30)
            puzzle_jpg.write_bytes(jpg_resp.content)
            subdir_img_counts[key] = obs + 1

    for target, count in subdir_img_counts.items():
        _log.info("Downloaded %d puzzle images to %s/", count, target)


def main() -> None:
    """CLI entry point: scrape puzzle images from a series index page."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Scrape puzzle images from a Guardian/Observer series index page"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Root directory to save images into",
    )
    parser.add_argument(
        "--series-url",
        default=_DEFAULT_SERIES,
        help=(
            "Series index URL with {} as the page-number placeholder. "
            "Default: Guardian killer-sudoku series."
        ),
    )
    parser.add_argument(
        "--url-contains",
        default=None,
        help=(
            "Only collect articles whose URL contains this substring. "
            "Guardian URLs encode difficulty (e.g. 'diabolical', 'hard'). "
            "Use to restrict to a specific puzzle series or difficulty. "
            "On Windows/Git Bash, set MSYS_NO_PATHCONV=1 before the command "
            "if the filter starts with '/' to prevent path expansion."
        ),
    )
    parser.add_argument(
        "--subdir-keywords",
        nargs="+",
        default=None,
        metavar="KEYWORD",
        help=(
            "Save images into subdirectories named after the first matching "
            "keyword found in each article URL (case-insensitive). Articles "
            "matching none of the keywords go into 'other/'. "
            "Example: --subdir-keywords easy medium hard diabolical"
        ),
    )
    parser.add_argument(
        "--max-per-subdir",
        type=int,
        default=None,
        metavar="N",
        help=(
            "Maximum images to collect per named subdir keyword (most recent first). "
            "Requires --subdir-keywords. Stops paginating once every named bucket "
            "is full, so large archives are not fully traversed."
        ),
    )
    args = parser.parse_args()
    scrape_puzzles(
        args.output_dir,
        series_url=args.series_url,
        url_contains=args.url_contains,
        subdir_keywords=args.subdir_keywords,
        max_per_subdir=args.max_per_subdir,
    )


if __name__ == "__main__":
    main()
