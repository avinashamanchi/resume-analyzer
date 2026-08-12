from __future__ import annotations

import argparse
from html.parser import HTMLParser
from pathlib import Path
import shutil
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"
API_ORIGIN = "https://resume-analyzer-al3g.onrender.com"


class _ReferenceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(
        self,
        _tag: str,
        attributes: list[tuple[str, str | None]],
    ) -> None:
        for name, value in attributes:
            if name in {"href", "src"} and value:
                self.references.append(value)


def validate(destination: Path) -> None:
    root = destination.resolve()
    for page in sorted(root.glob("*.html")):
        parser = _ReferenceParser()
        parser.feed(page.read_text())
        for reference in parser.references:
            if reference.startswith(("#", "https://", "mailto:")):
                continue
            if not reference.startswith("./"):
                raise ValueError("local asset reference is not relative")
            relative = Path(unquote(urlsplit(reference).path.removeprefix("./")))
            candidate = (root / relative).resolve()
            if root not in candidate.parents or not candidate.is_file():
                raise ValueError(f"missing local asset: {relative.as_posix()}")


def build(output: Path) -> None:
    destination = output.resolve()
    if destination in {ROOT.resolve(), STATIC.resolve()}:
        raise ValueError("Pages output must not replace source files")

    destination.mkdir(parents=True, exist_ok=True)
    for source in STATIC.iterdir():
        if source.is_file():
            shutil.copy2(source, destination / source.name)

    index_path = destination / "index.html"
    index = index_path.read_text()
    index = index.replace('href="/static/', 'href="./')
    index = index.replace('src="/static/', 'src="./')
    policy = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self' data:; connect-src 'self' " + API_ORIGIN + "; "
        "object-src 'none'; base-uri 'none'; form-action 'self'; "
        "upgrade-insecure-requests"
    )
    marker = "  <title>"
    configuration = (
        f'  <meta name="resume-ai-api-origin" content="{API_ORIGIN}">\n'
        f'  <meta http-equiv="Content-Security-Policy" content="{policy}">\n'
    )
    if marker not in index:
        raise ValueError("Resume.AI page title marker is missing")
    index_path.write_text(index.replace(marker, configuration + marker, 1))
    (destination / ".nojekyll").touch()
    validate(destination)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the Resume.AI GitHub Pages artifact")
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--output", type=Path)
    destination.add_argument("--validate-only", type=Path)
    args = parser.parse_args()
    try:
        if args.output is not None:
            build(args.output)
        else:
            validate(args.validate_only)
    except (OSError, UnicodeError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
