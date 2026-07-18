import '../../styles/lw-ui.css';

/**
 * UiCard — the one card system: 14px radius, hairline border, elevated bg.
 * tone 'warning' renders the amber blocking-banner look from the mockup
 * (amber-tinted ground and border; use it for the "what's blocking install"
 * banner). `footer` renders in a spaced row under the body.
 */
export function UiCard({ title, description, tone, children, footer }) {
  return (
    <section className={`lwui-card${tone ? ` lwui-card-${tone}` : ''}`}>
      {title != null && title !== '' && (
        <h4 className="lwui-card-title">{title}</h4>
      )}
      {description != null && description !== '' && (
        <p className="lwui-card-desc">{description}</p>
      )}
      {children}
      {footer != null && <div className="lwui-card-footer">{footer}</div>}
    </section>
  );
}

export default UiCard;
