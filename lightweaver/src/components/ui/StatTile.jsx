import '../../styles/lw-ui.css';

/**
 * StatTile — one rounded stat tile: small muted label above, large bold value.
 * tone 'ok' | 'danger' tints the value (green headroom / red overdraw).
 */
export function StatTile({ label, value, unit, tone }) {
  const toneClass =
    tone === 'ok' ? ' lwui-tile-ok' : tone === 'danger' ? ' lwui-tile-danger' : '';
  return (
    <div className="lwui-tile">
      <div className="lwui-tile-label">{label}</div>
      <div className={`lwui-tile-value${toneClass}`}>
        {value}
        {unit != null && unit !== '' && (
          <small className="lwui-tile-unit"> {unit}</small>
        )}
      </div>
    </div>
  );
}

/**
 * StatTileRow — grid wrapper for StatTiles. `columns` sets the column count
 * (defaults to 4, collapsing to 2 on narrow screens).
 */
export function StatTileRow({ children, columns }) {
  const style = columns
    ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
    : undefined;
  return (
    <div className="lwui-tile-row" style={style}>
      {children}
    </div>
  );
}

export default StatTile;
