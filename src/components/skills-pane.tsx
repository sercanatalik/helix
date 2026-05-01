import { useMemo, useState } from "react";
import { Badge, Button } from "./ui";
import { useSkills } from "../hooks/use-skills";
import type { Skill } from "../app/types";

/** Settings → Skills pane.
 *
 * Shows every skill the backend has discovered under
 * `~/.claude/skills/<name>/SKILL.md` and `<workspace>/.claude/skills/<name>/SKILL.md`,
 * grouped by source. The Rust side owns the file watcher; this pane is
 * read-only and simply reflects what's on disk. A "Refresh" button forces a
 * rescan when filesystem events were missed (e.g. the user just created the
 * top-level `.claude/skills/` directory). */
export function SkillsPane() {
  const { skills, reload } = useSkills();
  const [busy, setBusy] = useState(false);

  const grouped = useMemo(() => groupSkills(skills), [skills]);

  const onReload = async () => {
    setBusy(true);
    try {
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="providers-pane">
      <div className="settings-section-head">
        <h2 className="settings-section-title">Skills</h2>
        <Button variant="ghost" size="sm" onClick={() => void onReload()} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <p className="settings-section-desc">
        Skills extend helix with reusable instructions, mirroring Claude
        Desktop and Claude Code. Drop a folder under{" "}
        <code>~/.claude/skills/&lt;name&gt;/</code> with a{" "}
        <code>SKILL.md</code> file and it shows up here automatically. Project
        skills under <code>&lt;workspace&gt;/.claude/skills/</code> override
        same-named user skills. Type <code>/</code> in the composer to invoke
        one.
      </p>

      {skills.length === 0 ? (
        <p className="providers-empty">
          No skills found. Create one under <code>~/.claude/skills/</code> or
          your workspace's <code>.claude/skills/</code> to get started.
        </p>
      ) : null}

      {grouped.project.length > 0 ? (
        <SkillsGroup
          label="Project"
          hint="Loaded from the active workspace's .claude/skills directory."
          skills={grouped.project}
        />
      ) : null}
      {grouped.user.length > 0 ? (
        <SkillsGroup
          label="User"
          hint="Loaded from ~/.claude/skills, available across every workspace."
          skills={grouped.user}
        />
      ) : null}
    </section>
  );
}

interface GroupedSkills {
  readonly project: readonly Skill[];
  readonly user: readonly Skill[];
}

function groupSkills(skills: readonly Skill[]): GroupedSkills {
  const project: Skill[] = [];
  const user: Skill[] = [];
  for (const s of skills) {
    if (s.source === "project") project.push(s);
    else user.push(s);
  }
  return { project, user };
}

function SkillsGroup({
  label,
  hint,
  skills,
}: {
  readonly label: string;
  readonly hint: string;
  readonly skills: readonly Skill[];
}) {
  return (
    <>
      <div className="providers-section-label">{label}</div>
      <p className="providers-section-hint">{hint}</p>
      <ul className="providers-list">
        {skills.map((skill) => (
          <SkillRow key={skill.id} skill={skill} />
        ))}
      </ul>
    </>
  );
}

function SkillRow({ skill }: { readonly skill: Skill }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="provider-row" data-disabled={skill.error ? true : undefined}>
      <button
        type="button"
        className="provider-row-main"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="provider-row-head">
          <span className="provider-row-name">/{skill.name}</span>
          {skill.error ? (
            <Badge variant="outline">Error</Badge>
          ) : skill.disableModelInvocation ? (
            <Badge variant="muted">Manual</Badge>
          ) : (
            <Badge variant="default">Auto</Badge>
          )}
          {!skill.userInvocable ? (
            <Badge variant="outline">Hidden from menu</Badge>
          ) : null}
        </div>
        <div className="provider-row-meta">
          <span className="provider-row-url">
            {skill.description ?? <em>no description</em>}
          </span>
          {skill.argumentHint ? (
            <>
              <span className="provider-row-sep">·</span>
              <span className="provider-row-model">
                args: <code>{skill.argumentHint}</code>
              </span>
            </>
          ) : null}
        </div>
        {expanded ? (
          <div className="skill-row-detail">
            <dl className="skill-detail-list">
              <DetailRow label="Path">
                <code>{skill.skillMdPath}</code>
              </DetailRow>
              {skill.whenToUse ? (
                <DetailRow label="When to use">{skill.whenToUse}</DetailRow>
              ) : null}
              {skill.allowedTools && skill.allowedTools.length > 0 ? (
                <DetailRow label="Allowed tools">
                  {skill.allowedTools.join(", ")}
                </DetailRow>
              ) : null}
              {skill.paths && skill.paths.length > 0 ? (
                <DetailRow label="Paths">{skill.paths.join(", ")}</DetailRow>
              ) : null}
              {skill.arguments && skill.arguments.length > 0 ? (
                <DetailRow label="Arguments">
                  {skill.arguments.join(", ")}
                </DetailRow>
              ) : null}
              {skill.error ? (
                <DetailRow label="Error">
                  <span className="skill-detail-error">{skill.error}</span>
                </DetailRow>
              ) : null}
            </dl>
          </div>
        ) : null}
      </button>
    </li>
  );
}

function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="skill-detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
