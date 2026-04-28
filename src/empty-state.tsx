export function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-logo">
        <div className="empty-logo-mark">hx</div>
      </div>
      <h1 className="empty-title">helix-ai</h1>
      <p className="empty-desc">
        A scaffolded desktop chat shell. The structure is here — wire up a
        backend when you're ready.
      </p>
      <div className="empty-shortcuts">
        <div className="empty-shortcut">
          <kbd>⌘</kbd>
          <kbd>B</kbd>
          <span>Toggle sidebar</span>
        </div>
        <div className="empty-shortcut">
          <kbd>⌘</kbd>
          <kbd>,</kbd>
          <span>Settings</span>
        </div>
      </div>
    </div>
  );
}
