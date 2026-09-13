from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path


TRANSFORMED_FILES = ("index.html", "app.js", "styles.css")
COPIED_FILES = ("refresh_model.js", "shipping_filters.js")
REVIEW_BLOCK_PATTERN = re.compile(
    r"\s*(?:<!--|/\*) RELEASE_EXCLUDE_START: reviews (?:-->|\*/)"
    r".*?"
    r"(?:<!--|/\*) RELEASE_EXCLUDE_END: reviews (?:-->|\*/)\s*",
    re.DOTALL,
)
V2_MARKER_PATTERN = re.compile(
    r"\s*(?:<!--|/\*) RELEASE_EXCLUDE_(?:START|END): v2 (?:-->|\*/)\s*"
)


def _release_text(source_file: Path) -> str:
    source = source_file.read_text(encoding="utf-8")
    release, removed_reviews = REVIEW_BLOCK_PATTERN.subn("\n", source)
    release, removed_v2_markers = V2_MARKER_PATTERN.subn("\n", release)
    if removed_reviews == 0 or removed_v2_markers == 0:
        raise ValueError(f"V2 release markers are missing: {source_file.name}")
    return release


def prepare_release_assets(source: Path, target: Path) -> None:
    source = source.resolve()
    target = target.resolve()
    if source == target or source in target.parents:
        raise ValueError("release assets target must be outside the development asset directory")

    target.mkdir(parents=True, exist_ok=False)
    for name in TRANSFORMED_FILES:
        (target / name).write_text(_release_text(source / name), encoding="utf-8")
    for name in COPIED_FILES:
        shutil.copy2(source / name, target / name)

    html = (target / "index.html").read_text(encoding="utf-8")
    javascript = (target / "app.js").read_text(encoding="utf-8")
    css = (target / "styles.css").read_text(encoding="utf-8")
    if html.count('class="nav-item') != 7 or html.count('<section id="page-') != 7:
        raise ValueError("V2 release WebView must contain exactly seven navigation entries and pages")
    required = (
        "运费模板",
        'data-page="shipping"',
        'id="page-shipping"',
        "get_shipping_templates",
        "基础服务费",
        'data-page="service-fee"',
        'id="page-service-fee"',
        "get_basic_service_fee_rates",
    )
    forbidden = (
        "人工核验",
        'data-page="reviews"',
        'id="page-reviews"',
        "get_mapping_reviews",
        "resolve_mapping_review",
        "refreshMappingReviews",
        "reviewText",
        ".review-",
        "RELEASE_EXCLUDE",
    )
    combined = html + javascript + css
    missing = [value for value in required if value not in combined]
    if missing:
        raise ValueError(f"V2 release WebView is missing resources: {', '.join(missing)}")
    found = [value for value in forbidden if value in combined]
    if found:
        raise ValueError(f"V2 release WebView still contains review resources: {', '.join(found)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare the seven-page V2 release WebView assets")
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    prepare_release_assets(args.source, args.target)
    print(f"Release WebView assets created: {args.target.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
