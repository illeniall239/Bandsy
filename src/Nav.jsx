// Shared chrome for every non-exam screen (Swiss Neutral): wordmark left, one white pill nav, an optional right slot.
const LINKS = [["#/", "Home"], ["#/tests", "Tests"], ["#/practice", "Practice"], ["#/vocab", "Words"], ["#/history", "History"], ["#/settings", "Settings"]];

export function TopNav({ right }) {
  const here = location.hash.split("?")[0] || "#/";
  const on = href => href === "#/" ? here === "#/" : here.startsWith(href) || (href === "#/history" && here.startsWith("#/r/")) || (href === "#/vocab" && here.startsWith("#/review"));
  return (
    <header className="topnav">
      <span className="left"><a className="brand" href="#/">BANDSY</a></span>
      <nav className="pills">{LINKS.map(([href, label]) => <a key={href} href={href} className={on(href) ? "on" : ""} aria-current={on(href) ? "page" : undefined}>{label}</a>)}</nav>
      <div className="right">{right}</div>
    </header>);
}

/** Page title block: grey eyebrow, big tight title, optional meta line and actions on the right. */
export function PageHead({ eyebrow, title, meta, children }) {
  return (
    <div className="pagehead">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {meta && <p className="meta">{meta}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </div>);
}
