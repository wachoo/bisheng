"use strict";

const element = id => document.getElementById(id);
const sourcePath = "/admin/sources";
const apiRoot = "/admin/api/sources";
const sampleStatus = { new: "新增", updated: "更新", unchanged: "内容相同" };
const runStatus = { success: "完成", partial: "部分失败", failed: "失败" };
const clock = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });
let detailUrl;
let samples = [];

function node(tag, text) {
  const result = document.createElement(tag);
  if (text != null) result.textContent = text;
  return result;
}

async function request(url, method = "GET", body) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") headers["X-Admin-Request"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, body: JSON.stringify(body), cache: "no-store" });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const reason = typeof error?.detail === "string" ? error.detail : `请求失败（HTTP ${response.status}）`;
    throw new Error(reason);
  }
  if (response.status === 204) return null;
  return response.json();
}

function setMessage(id, message, isError = false) {
  const output = element(id);
  output.classList.toggle("error", isError);
  output.textContent = message;
}

function timeText(value) {
  return value ? clock.format(new Date(value * 1000)) : "暂无";
}

function intervalText(seconds) {
  for (const [size, unit] of [[86400, "天"], [3600, "小时"], [60, "分钟"]]) {
    if (seconds % size === 0) return `${seconds / size} ${unit}`;
  }
  return `${seconds} 秒`;
}

function statusBadge(enabled) {
  const badge = node("span", enabled ? "已启用" : "已暂停");
  badge.className = `badge ${enabled ? "active" : "paused"}`;
  return badge;
}

function resultText(result) {
  return `新增 ${result.new} · 更新 ${result.updated} · 相同 ${result.unchanged} · 失败 ${result.failed}`;
}

function errorDetails(errors) {
  if (!errors?.length) return document.createTextNode("");
  const details = node("details");
  details.append(node("summary", `失败原因（${errors.length}）`));
  const list = node("ul");
  for (const error of errors) list.append(node("li", error));
  details.append(list);
  return details;
}

function row(...contents) {
  const tableRow = node("tr");
  for (const content of contents) {
    const cell = node("td");
    cell.append(content);
    tableRow.append(cell);
  }
  return tableRow;
}

function renderOverview(sources) {
  const rows = element("sources");
  for (const source of sources) {
    const link = node("a", source.name);
    link.href = `${sourcePath}/${encodeURIComponent(source.id)}`;
    const result = source.last_result;
    const lastResult = node("div", result ? `${runStatus[result.status]} · ${resultText(result)}` : "暂无采集记录");
    if (result) lastResult.append(errorDetails(result.errors));
    rows.append(row(link, statusBadge(source.enabled), intervalText(source.interval_seconds),
      timeText(source.last_attempt_at), timeText(source.last_sync_at), lastResult));
  }
  if (!sources.length) {
    const empty = row("暂无信息源。");
    empty.firstElementChild.colSpan = 6;
    rows.append(empty);
  }
  element("overview").hidden = false;
}

function externalLink(value) {
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol)) {
      const link = node("a", value);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }
  } catch { /* Invalid source URLs remain readable as text. */ }
  return document.createTextNode(value || "暂无");
}

function renderDetail(source) {
  document.title = `${source.name} · 信息源管理`;
  element("crumb").textContent = source.name;
  element("crumb").hidden = false;
  element("source-name").textContent = source.name;
  element("enabled-state").replaceChildren(statusBadge(source.enabled));
  element("description").textContent = source.description;
  element("homepage").replaceChildren(externalLink(source.original_url));
  element("last-attempt").textContent = timeText(source.last_attempt_at);
  element("last-sync").textContent = timeText(source.last_sync_at);
  element("last-change").textContent = timeText(source.article_list_updated_at);
  element("enabled").value = source.enabled ? "yes" : "no";
  element("interval").value = source.interval_seconds;
  const runs = source.runs || [];
  element("runs").replaceChildren();
  for (const run of runs) {
    const counts = node("div", resultText(run));
    counts.append(errorDetails(run.errors));
    element("runs").append(row(timeText(run.started_at), timeText(run.finished_at), runStatus[run.status], counts));
  }
  element("no-runs").hidden = runs.length > 0;
  element("run-table").hidden = runs.length === 0;
  element("detail").hidden = false;
}

async function saveSettings(event) {
  event.preventDefault();
  const fields = event.currentTarget.querySelector("fieldset");
  fields.disabled = true;
  setMessage("save-state", "正在保存…");
  try {
    const source = await request(detailUrl, "PATCH", {
      enabled: element("enabled").value === "yes",
      interval_seconds: element("interval").valueAsNumber,
    });
    renderDetail(source);
    setMessage("save-state", "设置已保存。");
  } catch (error) {
    setMessage("save-state", `保存失败：${error.message}`, true);
  } finally {
    fields.disabled = false;
  }
}

// Keep the frame passive. Administrators can open individual image URLs from
// the source list outside the frame without fetching them during preview.
function previewHtml(html, articleUrl, imageSources) {
  const input = node("template");
  input.innerHTML = html;
  const allowed = new Set(("P BR HR H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE EM STRONG B I " +
    "TABLE CAPTION COLGROUP COL THEAD TBODY TFOOT TR TD TH FIGURE FIGCAPTION DL DT DD DIV SPAN SUP SUB").split(" "));
  const discard = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "SVG", "MATH"]);
  function imageReference(image) {
    const label = image.getAttribute("alt")?.trim() || image.getAttribute("title")?.trim();
    const src = image.getAttribute("src")?.trim();
    let url;
    if (src) {
      try {
        const candidate = new URL(src, articleUrl);
        if (["https:", "http:"].includes(candidate.protocol) && !candidate.username && !candidate.password) {
          url = candidate.href;
        }
      } catch { /* The label still identifies an image without a usable URL. */ }
    }
    imageSources.push({ label, url });
    const reference = node("span", `图 ${imageSources.length}${label ? " · " + label : ""}`);
    reference.className = "image-reference";
    return reference;
  }
  function copyChildren(from, into) {
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        into.append(document.createTextNode(child.textContent));
      } else if (child.nodeName === "IMG") {
        into.append(imageReference(child));
      } else if (child.nodeType === Node.ELEMENT_NODE && !discard.has(child.tagName.toUpperCase())) {
        let parent = into;
        if (allowed.has(child.tagName)) {
          parent = node(child.localName);
          if (child.tagName === "TH" || child.tagName === "TD") {
            if (child.hasAttribute("colspan")) parent.colSpan = child.colSpan;
            if (child.hasAttribute("rowspan")) parent.rowSpan = child.rowSpan;
            if (child.tagName === "TH" && ["row", "col", "rowgroup", "colgroup"].includes(child.scope)) {
              parent.scope = child.scope;
            }
          } else if (child.tagName === "OL") {
            if (child.hasAttribute("start")) parent.start = child.start;
            if (["1", "A", "a", "I", "i"].includes(child.type)) parent.type = child.type;
            parent.reversed = child.reversed;
          } else if (child.tagName === "LI" && child.hasAttribute("value")) {
            parent.value = child.value;
          } else if (["COL", "COLGROUP"].includes(child.tagName) && child.hasAttribute("span")) {
            parent.span = child.span;
          }
          into.append(parent);
        }
        copyChildren(child, parent);
      }
    }
  }
  const result = node("div");
  copyChildren(input.content, result);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>
      body { margin: 14px; color: #172b35; font: 15px/1.65 system-ui, sans-serif; overflow-wrap: anywhere; }
      table { border-collapse: collapse; }
      th, td { border: 1px solid #aebfc3; padding: 4px 8px; text-align: start; vertical-align: top; }
      th { background: #edf3f3; } caption { text-align: start; font-weight: 600; }
      figure { margin: 1em 0; } figcaption, .image-reference { color: #405d65; }
      .image-reference { display: inline-block; padding: 2px 8px; border: 1px dashed #8da3a9; }
      pre { white-space: pre-wrap; }
    </style></head><body>${result.innerHTML}</body></html>`;
}

function showSample() {
  const article = samples[element("sample-select").selectedIndex];
  if (!article) return;
  element("article-title").textContent = article.title;
  element("article-id").textContent = article.id;
  element("article-url").replaceChildren(externalLink(article.original_url));
  element("markdown").textContent = article.markdown_content || "正文为空。";
  const frame = element("html-preview");
  const images = [];
  frame.srcdoc = previewHtml(article.html_content || "<p>正文为空。</p>", article.original_url, images);
  element("image-sources")?.remove();
  if (images.length) {
    const section = node("section");
    section.id = "image-sources";
    section.append(node("h4", "正文图片来源"));
    const list = node("ol");
    for (const image of images) {
      const item = node("li", image.label ? image.label + " · " : "");
      item.append(image.url ? externalLink(image.url) : "来源未提供可打开的图片地址");
      list.append(item);
    }
    section.append(list);
    frame.after(section);
  }
}

async function preview() {
  const button = element("preview-button");
  button.disabled = true;
  samples = [];
  element("sample").hidden = true;
  element("preview-errors").replaceChildren();
  setMessage("preview-state", "正在获取来源条目并转换正文…");
  try {
    const result = await request(detailUrl + "/preview", "POST");
    setMessage("preview-state", resultText(result));
    element("preview-errors").append(errorDetails(result.errors));
    samples = result.items;
    if (samples.length) {
      const select = element("sample-select");
      select.replaceChildren();
      for (const article of samples) select.append(node("option", `${sampleStatus[article.status]} · ${article.title}`));
      showSample();
      element("sample").hidden = false;
    }
  } catch (error) {
    const message = error.message.startsWith("试采失败") ? error.message : `试采失败：${error.message}`;
    setMessage("preview-state", message, true);
  } finally {
    button.disabled = false;
  }
}

async function init() {
  try {
    const id = location.pathname.slice(sourcePath.length + 1).replace(/\/$/, "");
    if (id) {
      detailUrl = `${apiRoot}/${encodeURIComponent(decodeURIComponent(id))}`;
      renderDetail(await request(detailUrl));
      element("settings").addEventListener("submit", saveSettings);
      element("preview-button").addEventListener("click", preview);
      element("sample-select").addEventListener("change", showSample);
    } else {
      renderOverview(await request(apiRoot));
    }
  } catch (error) {
    element("page-error").hidden = false;
    setMessage("page-error", `无法读取信息源：${error.message}`, true);
  } finally {
    element("loading").hidden = true;
  }
}

init();
