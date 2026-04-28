import re, pathlib, sys
mapping = {
  7: 'var(--fs-2xs)', 8: 'var(--fs-2xs)', 9: 'var(--fs-2xs)',
  10: 'var(--fs-xs)',
  11: 'var(--fs-sm)',
  12: 'var(--fs-md)', 13: 'var(--fs-md)',
  14: 'var(--fs-lg)', 15: 'var(--fs-lg)', 16: 'var(--fs-lg)',
  18: 'var(--fs-xl)', 20: 'var(--fs-xl)',
}
pat = re.compile(r"fontSize:(\s*)(\d+)(?!\d|\.)")
root = pathlib.Path(sys.argv[1])
total = 0
report = []
for p in root.rglob('*'):
    if p.suffix not in ('.jsx', '.js'):
        continue
    src = p.read_text()
    hits = [m for m in pat.finditer(src) if int(m.group(2)) in mapping]
    if not hits:
        continue
    def sub(m):
        n = int(m.group(2))
        if n in mapping:
            return f"fontSize:{m.group(1)}'{mapping[n]}'"
        return m.group(0)
    new = pat.sub(sub, src)
    if new != src:
        report.append((str(p.relative_to(root)), len(hits)))
        total += len(hits)
        p.write_text(new)
for f, c in report:
    print(f"{f}: {c}")
print(f"total replacements: {total}")
