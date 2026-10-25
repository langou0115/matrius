"""Small structural fallback for pages the article extractor cannot identify."""

import re
from urllib.parse import urljoin, urlsplit

from lxml import html


def _text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "")


def _render(node, url: str) -> str:
    if not isinstance(node.tag, str):
        return ""
    tag = node.tag.lower()
    if tag == "pre":
        code = node.text_content().strip("\n")
        fence = "`" * max(3, max((len(run) + 1 for run in re.findall(r"`+", code)), default=3))
        return f"\n\n{fence}\n{code}\n{fence}\n\n"
    if tag == "table":
        rows = [[_render(cell, url).strip().replace("|", r"\|").replace("\n", " ") for cell in row]
                for row in node.xpath("./tr|./thead/tr|./tbody/tr|./tfoot/tr")]
        rows = [row for row in rows if row]
        if not rows:
            return ""
        width = max(map(len, rows))
        lines = ["| " + " | ".join(row + [""] * (width - len(row))) + " |" for row in rows]
        lines.insert(1, "| " + " | ".join(["---"] * width) + " |")
        return "\n\n" + "\n".join(lines) + "\n\n"
    body = _text(node.text) + "".join(_render(child, url) + _text(child.tail) for child in node)
    if tag == "a":
        href = urljoin(url, node.get("href", ""))
        try:
            parsed = urlsplit(href)
        except ValueError:
            return body
        if parsed.scheme in ("http", "https") and not parsed.username and not parsed.password and body.strip():
            return f"[{body.strip()}]({href.replace(' ', '%20').replace(')', '%29')})"
    if tag == "code":
        code = node.text_content().strip()
        fence = "`" * max(1, max((len(run) + 1 for run in re.findall(r"`+", code)), default=1))
        return f"{fence}{code}{fence}"
    if re.fullmatch(r"h[1-6]", tag):
        return f"\n\n{'#' * int(tag[1])} {body.strip()}\n\n"
    if tag == "li":
        prefix = "1." if node.getparent() is not None and node.getparent().tag == "ol" else "-"
        return f"\n{prefix} {body.strip()}\n"
    if tag == "br":
        return "\n"
    if tag in ("p", "div", "section", "article", "main", "ul", "ol", "blockquote"):
        return f"\n\n{body.strip()}\n\n"
    return body


def extract_markdown(body: str, url: str, *, main_only: bool) -> tuple[str, str]:
    tree = html.fromstring(body)
    titles = tree.xpath("//title|//h1")
    title = " ".join(titles[0].text_content().split()) if titles else url
    for node in tree.xpath("//script|//style|//noscript|//template|//iframe|//object|//embed"):
        node.drop_tree()
    content = tree
    if main_only:
        candidates = tree.xpath("//article|//main|//*[@role='main']")
        if candidates:
            content = max(candidates, key=lambda item: len(item.text_content()))
        else:
            for node in tree.xpath("//nav|//header|//footer|//aside"):
                node.drop_tree()
    return title, re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", _render(content, url)).strip()
