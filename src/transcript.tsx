export function Transcript() {
  return (
    <section className="transcript scroll">
      <div className="transcript-inner">
        <div className="msg">
          <div className="msg-role" data-role="assistant">
            assistant
          </div>
          <div className="msg-content">
            <p>
              Welcome to <b>Helix AI</b>. This is a layout-only scaffold — no LLM
              is wired up yet. The design is modular: change the active theme
              from <kbd>Settings → Appearance</kbd>.
            </p>
            <p>
              Add a new theme by dropping a CSS file under
              <code> src/themes/ </code>
              and registering it in
              <code> src/themes/index.ts </code>.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
