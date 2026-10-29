/**
 * Arrow-key checkbox list for the terminal, no dependencies.
 *   ↑/↓ move · Space tick · Tab tick all / none (of the filtered list) · type to filter · Enter confirm · Esc quit
 * Returns the indices of the ticked items, or null when cancelled.
 */
import readline from "readline";

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", inverse: "\x1b[7m" };

export function checkbox({ title, items, checked = [], hint = "", min = 1, single = false, input = process.stdin, output = process.stdout }) {
  return new Promise((resolve) => {
    const ticked = new Set(checked);
    let cursor = Math.max(0, items.findIndex((_, i) => ticked.has(i)));
    let filter = "";
    let message = "";
    let drawn = 0;
    let top = 0;

    const visible = () => items.map((it, i) => ({ ...it, i })).filter((it) => !filter || it.label.toLowerCase().includes(filter.toLowerCase()));
    // Leave room for wide characters (emoji, CJK) so no line wraps and breaks the redraw.
    const width = () => Math.max(40, (output.columns || 100) - 4);
    const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const fit = (s) => {
      const max = width();
      return strip(s).length <= max ? s : strip(s).slice(0, max - 1) + "…";
    };

    function render() {
      const list = visible();
      cursor = Math.min(cursor, Math.max(0, list.length - 1));
      const rows = Math.max(5, (output.rows || 30) - 8);
      if (cursor < top) top = cursor;
      if (cursor >= top + rows) top = cursor - rows + 1;
      top = Math.max(0, Math.min(top, Math.max(0, list.length - rows)));

      const lines = [fit(`${c.bold}${title}${c.reset}`)];
      lines.push(
        single
          ? `${c.dim}↑↓ move · Enter choose · Esc quit${c.reset}`
          : `${c.dim}↑↓ move · Space tick · Tab all/none · type to filter · Enter confirm · Esc quit${c.reset}`
      );
      lines.push(filter ? `${c.yellow}filter: ${filter}${c.reset}  ${c.dim}(Backspace to edit)${c.reset}` : "");
      if (single) lines.pop();
      if (top > 0) lines.push(`${c.dim}   ↑ ${top} more${c.reset}`);
      for (const [k, it] of list.slice(top, top + rows).entries()) {
        const here = top + k === cursor;
        const on = single ? here : ticked.has(it.i);
        const box = on ? `${c.green}${single ? "(•)" : "[x]"}${c.reset}` : single ? "( )" : "[ ]";
        const label = here ? `${c.inverse}${it.label}${c.reset}` : it.label;
        lines.push(fit(`${here ? `${c.cyan}❯${c.reset}` : " "} ${box} ${label}${it.note ? ` ${c.dim}${it.note}${c.reset}` : ""}`));
      }
      if (!list.length) lines.push(`${c.dim}   (nothing matches "${filter}")${c.reset}`);
      if (top + rows < list.length) lines.push(`${c.dim}   ↓ ${list.length - top - rows} more${c.reset}`);
      if (!single) lines.push(`${c.bold}${ticked.size} selected${c.reset}${hint ? `  ${c.dim}${hint(ticked.size)}${c.reset}` : ""}`);
      lines.push(message ? `${c.yellow}${message}${c.reset}` : "");

      output.write((drawn ? `\x1b[${drawn}F` : "") + "\x1b[J" + lines.join("\n") + "\n");
      drawn = lines.length;
      message = "";
    }

    function finish(result) {
      input.removeListener("keypress", onKey);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h");
      resolve(result);
    }

    function onKey(str, key = {}) {
      const list = visible();
      const cur = list[cursor];
      if ((key.ctrl && key.name === "c") || key.name === "escape") return finish(null);
      if (key.name === "up") cursor = cursor > 0 ? cursor - 1 : Math.max(0, list.length - 1);
      else if (key.name === "down") cursor = cursor < list.length - 1 ? cursor + 1 : 0;
      else if (key.name === "pageup") cursor = Math.max(0, cursor - 10);
      else if (key.name === "pagedown") cursor = Math.min(list.length - 1, cursor + 10);
      else if (single) {
        if ((key.name === "return" || key.name === "enter" || key.name === "space") && cur) return finish([cur.i]);
      } else if (key.name === "space" && cur) {
        if (ticked.has(cur.i)) ticked.delete(cur.i);
        else ticked.add(cur.i);
      } else if (key.name === "return" || key.name === "enter") {
        if (ticked.size >= min) return finish([...ticked].sort((a, b) => a - b));
        message = `Tick at least ${min} with Space first.`;
      } else if (key.name === "backspace") filter = filter.slice(0, -1);
      else if (key.name === "tab" || (key.ctrl && key.name === "a")) {
        const all = list.every((it) => ticked.has(it.i));
        for (const it of list) all ? ticked.delete(it.i) : ticked.add(it.i);
      } else if (str && str.length === 1 && str >= " " && !key.ctrl && !key.meta) {
        filter += str;
        cursor = 0;
      }
      render();
    }

    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.on("keypress", onKey);
    input.resume();
    output.write("\x1b[?25l");
    render();
  });
}
