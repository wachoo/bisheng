"""Turn an upstream article fragment into safe HTML, Markdown and searchable text."""

import re
from html import escape
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

from bs4 import (
    BeautifulSoup,
    Comment,
    Doctype,
    NavigableString,
    ProcessingInstruction,
    Tag,
)

BLOCKS = {
    "article",
    "section",
    "main",
    "div",
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "pre",
    "blockquote",
    "figure",
    "figcaption",
    "table",
    "caption",
    "tr",
    "hr",
}
ALLOWED = BLOCKS | {
    "br",
    "strong",
    "em",
    "del",
    "u",
    "sub",
    "sup",
    "code",
    "a",
    "img",
    "thead",
    "tbody",
    "tfoot",
    "td",
    "th",
}
DISCARD = {
    "script",
    "style",
    "template",
    "noscript",
    "head",
    "title",
    "meta",
    "link",
    "base",
    "iframe",
    "frame",
    "object",
    "embed",
    "svg",
    "math",
    "canvas",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "nav",
    "audio",
    "video",
    "source",
    "track",
    "map",
    "area",
}
HIDDEN_STYLE = re.compile(
    r"(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)",
    re.IGNORECASE,
)
ALIASES = {
    "b": "strong",
    "i": "em",
    "s": "del",
    "strike": "del",
    "center": "div",
    "address": "p",
}
HTML_SPACE = re.compile(r"[\t\r\n\f ]+")
HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


def absolute_url(value, base):
    if not value or not isinstance(value, str):
        return None
    value = value.strip()
    if not value or re.search(r'[\x00-\x1f\x7f\\"<>]', value):
        return None
    try:
        parts = urlsplit(urljoin(base, value))
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
        ):
            return None
        if re.search(r"\s", parts.netloc):
            return None
        # Validate the port before handing a link to a browser.
        if parts.port is not None and parts.port == 0:
            return None
        return urlunsplit(
            (
                parts.scheme,
                parts.netloc,
                quote(parts.path, safe="/!$&'()*+,;=:@%-._~"),
                quote(parts.query, safe="/?!$&'()*+,;=:@%-._~"),
                quote(parts.fragment, safe="/?!$&'()*+,;=:@%-._~"),
            )
        )
    except ValueError:
        return None


def sanitize(fragment, base):
    soup = BeautifulSoup(fragment, "html.parser")
    for token in soup.find_all(
        string=lambda value: isinstance(
            value, (Comment, Doctype, ProcessingInstruction)
        )
    ):
        token.extract()
    # Process in document order so discarded containers cannot contribute child content.
    for tag in soup.find_all(True):
        if tag.decomposed:  # An ancestor was discarded.
            continue
        name = tag.name
        attrs = tag.attrs
        hidden = (
            "hidden" in attrs
            or str(attrs.get("aria-hidden", "")).lower() == "true"
            or HIDDEN_STYLE.search(attrs.get("style", ""))
        )
        if name in DISCARD or hidden:
            tag.decompose()
            continue
        if name in ALIASES:
            tag.name = name = ALIASES[name]
        if name == "span":
            style = attrs.get("style", "")
            if re.search(
                r"(?:^|;)\s*font-weight\s*:\s*(?:bold|[6-9]00)\b", style, re.IGNORECASE
            ):
                tag.name = name = "strong"
            elif re.search(
                r"(?:^|;)\s*font-style\s*:\s*italic\b", style, re.IGNORECASE
            ):
                tag.name = name = "em"
        if name not in ALLOWED:
            tag.unwrap()
            continue
        tag.attrs = {}
        if name == "a":
            url = absolute_url(attrs.get("href"), base)
            if url:
                tag["href"] = url
            else:
                tag.unwrap()
        elif name == "img":
            if (
                attrs.get("width") in {"0", "1"} and attrs.get("height") in {"0", "1"}
            ) or attrs.get("role") in {"presentation", "none"}:
                tag.decompose()
                continue
            url = next(
                (
                    target
                    for key in ("data-original", "data-src", "src")
                    if (target := absolute_url(attrs.get(key), base))
                ),
                None,
            )
            alt = (
                str(attrs.get("alt", "")).strip() or str(attrs.get("title", "")).strip()
            )
            if not url:
                tag.replace_with(alt)
                continue
            tag["src"] = url
            if alt:
                tag["alt"] = alt
        elif name in ("td", "th"):
            if name == "th" and attrs.get("scope") in {
                "row",
                "col",
                "rowgroup",
                "colgroup",
            }:
                tag["scope"] = attrs["scope"]
            for attr in ("rowspan", "colspan"):
                span = str(attrs.get(attr, ""))
                # HTML rowspan=0 means all remaining rows in the group.
                if re.fullmatch(r"[0-9]{1,5}", span) and (
                    int(span) > 1 or attr == "rowspan" and int(span) == 0
                ):
                    tag[attr] = str(int(span))
        elif name == "ol":
            start = str(attrs.get("start", ""))
            if re.fullmatch(r"-?\d{1,9}", start):
                tag["start"] = start
            if "reversed" in attrs:
                tag["reversed"] = ""
        elif name == "li" and re.fullmatch(r"-?\d{1,9}", str(attrs.get("value", ""))):
            tag["value"] = attrs["value"]
    for number, image in enumerate(soup.find_all("img"), 1):
        if "alt" not in image.attrs:
            figure = image.find_parent("figure")
            caption = figure.find("figcaption") if figure else None
            label = caption.get_text(" ", strip=True) if caption else ""
            if not label:
                filename = unquote(
                    urlsplit(image["src"]).path.rsplit("/", 1)[-1]
                ).rsplit(".", 1)[0]
                # Keep a descriptive asset name. Generic IDs and hashes do not describe the picture.
                if re.search(
                    r"[\u3400-\u9fff]|[a-zA-Z]{3,}[-_ ][a-zA-Z]{3,}", filename
                ):
                    label = filename.replace("_", " ").replace("-", " ").strip()
            if not label:
                heading = image.find_previous(list(HEADINGS))
                subject = heading.get_text(" ", strip=True) if heading else ""
                label = f"{subject}配图" if subject else f"正文插图 {number}"
            image["alt"] = label
    return soup


def md_text(text):
    # Escape literal markup supplied as text; source-created links are emitted only by render_markdown.
    return re.sub(
        r"([\\`*_\[\]~#!])", r"\\\1", escape(HTML_SPACE.sub(" ", text), quote=False)
    )


def markdown_children(node):
    return "".join(render_markdown(child) for child in node.children)


def block(content):
    return "\n\n" + content.strip() + "\n\n" if content.strip() else ""


def markdown_list(tag):
    if tag.has_attr("reversed") or tag.find("li", value=True):
        return str(tag)
    lines = []
    start = int(tag.get("start", 1))
    for offset, item in enumerate(tag.find_all("li", recursive=False)):
        prefix = f"{start + offset}. " if tag.name == "ol" else "- "
        pieces = []
        for child in item.children:
            if isinstance(child, Tag) and child.name in ("ul", "ol"):
                pieces.append("\n" + markdown_list(child).strip())
            else:
                pieces.append(render_markdown(child))
        content = "".join(pieces).strip()
        content = re.sub(r"\n{3,}", "\n\n", content)
        lines.append(prefix + content.replace("\n", "\n" + " " * len(prefix)))
    return "\n".join(lines)


def markdown_table(table):
    rows = table.find_all("tr")
    if (
        table.find("table")
        or table.find(attrs={"colspan": True})
        or table.find(attrs={"rowspan": True})
        or table.find("th", scope=["row", "rowgroup", "colgroup"])
    ):
        return block(str(table))
    cells = [row.find_all(["th", "td"], recursive=False) for row in rows]
    if not cells or not cells[0] or any(len(row) != len(cells[0]) for row in cells):
        return block(str(table))
    # Keep complex cell blocks and row headers in HTML; GFM can't express these without loss.
    if table.find(["ul", "ol", "pre", "blockquote", "figure", *HEADINGS]):
        return block(str(table))
    if any(cell.name == "th" for row in cells[1:] for cell in row):
        return block(str(table))
    first_is_header = (
        all(cell.name == "th" for cell in cells[0])
        or rows[0].find_parent("thead") is not None
    )
    if not first_is_header and any(cell.name == "th" for cell in cells[0]):
        return block(str(table))

    def render_row(row):
        values = []
        for cell in row:
            value = re.sub(r"[ \t]*\n+[ \t]*", "<br>", markdown_children(cell).strip())
            values.append(value.replace("|", r"\|"))
        return "| " + " | ".join(values) + " |"

    width = len(cells[0])
    if first_is_header:
        header = render_row(cells[0])
        cells = cells[1:]
    else:
        header = "| " + " | ".join([""] * width) + " |"
    lines = [header, "| " + " | ".join(["---"] * width) + " |"]
    lines.extend(render_row(row) for row in cells)
    caption = table.find("caption", recursive=False)
    return (block(markdown_children(caption)) if caption else "") + block(
        "\n".join(lines)
    )


def render_markdown(node):
    if isinstance(node, NavigableString):
        return md_text(str(node))
    name = node.name
    if name == "br":
        return "  \n"
    if name == "hr":
        return block("---")
    if name == "img":
        return "![" + md_text(node["alt"]) + "](<" + node["src"] + ">)"
    if name == "pre":
        code = node.get_text().rstrip("\n")
        longest = max((len(run) for run in re.findall(r"`+", code)), default=0)
        fence = "`" * max(3, longest + 1)
        return block(f"{fence}\n{code}\n{fence}")
    if name == "code":
        code = node.get_text()
        fence = "`" * (
            max((len(run) for run in re.findall(r"`+", code)), default=0) + 1
        )
        pad = " " if code.startswith("`") or code.endswith("`") else ""
        return fence + pad + code + pad + fence
    if name in ("ul", "ol"):
        return block(markdown_list(node))
    if name == "table":
        return markdown_table(node)
    children = markdown_children(node)
    if name == "a":
        return (
            "["
            + (children.strip() or md_text(node["href"]))
            + "](<"
            + node["href"]
            + ">)"
        )
    if name in {"strong", "em", "del"}:
        marker = {"strong": "**", "em": "*", "del": "~~"}[name]
        if not children.strip():
            return children
        return (
            (" " if children[0].isspace() else "")
            + marker
            + children.strip()
            + marker
            + (" " if children[-1].isspace() else "")
        )
    if name in {"sub", "sup", "u"}:
        return str(node)
    if name in HEADINGS:
        return block("#" * int(name[1]) + " " + children.strip())
    if name == "blockquote":
        lines = children.strip().splitlines()
        return block("\n".join("> " + line for line in lines))
    if name in BLOCKS:
        return block(children)
    return children


def plain(node):
    if isinstance(node, NavigableString):
        return HTML_SPACE.sub(" ", str(node))
    if node.name == "br":
        return "\n"
    if node.name == "img":
        return node["alt"]
    if node.name == "pre":
        return "\n" + node.get_text() + "\n"
    content = "".join(plain(child) for child in node.children)
    if node.name in ("td", "th"):
        return content.strip() + "\t"
    if node.name in BLOCKS:
        return "\n" + content.strip() + "\n"
    return content


def only_media_references(html, title):
    """Whether an article consists of media/attachment references and their labels."""
    if "<img " not in html and "<a " not in html:
        return False
    tree = BeautifulSoup(html, "html.parser")
    if tree.find("table"):
        return False
    for reference in tree.select("a, img, figcaption"):
        reference.decompose()
    remainder = re.sub(r"\s+", "", tree.get_text())
    if title:
        remainder = remainder.removeprefix(re.sub(r"\s+", "", title))
    return bool(
        re.fullmatch(
            r"(?:(?:公告|正文)?(?:详见附件|见附件|见下图|扫描件)|附件\d*|[（()）:：。；;])*",
            remainder,
        )
    )


def convert_html(fragment, base_url):
    """Return Markdown, inert HTML and plain text. Resources remain external references."""
    tree = sanitize(fragment, base_url)
    try:
        md = markdown_children(tree).strip()
        raw_text = plain(tree)
    except RecursionError as exc:
        raise ValueError("上游正文嵌套层数过深，无法保留结构") from exc
    # Collapse blank lines created by adjacent block wrappers. Fenced code can
    # contain meaningful blank lines; retain those when a fragment includes pre.
    if tree.find("pre") is None:
        md = re.sub(r"\n(?:[ \t]*\n){2,}", "\n\n", md)
    text = "\n".join(line.strip() for line in raw_text.splitlines() if line.strip())
    return md, tree.decode_contents().strip(), text
