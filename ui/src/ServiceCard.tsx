/**
 * One service, as a card.
 *
 * Modelled on how Zerops draws its own architecture diagrams — a stack of small container
 * glyphs above the service name — because a developer who has seen the Zerops docs should
 * recognise this immediately. It is a familiar picture filled with their real numbers.
 *
 * WHAT THE CARD IS NOT ALLOWED TO IMPLY:
 *
 *   A service that has never deployed shows NO container glyphs and says "not deployed".
 *   Drawing one glyph would put a box on screen for a process that has never existed, and
 *   that is the single easiest way for this diagram to lie.
 *
 *   The HA badge appears only when the platform says `mode === 'HA'`. It is never derived
 *   from how many containers happen to be up, because a single-mode service mid-deploy can
 *   briefly run several.
 *
 *   A ghost card is a service the repo needs and the project does not have. It is dashed,
 *   greyed, and labelled — it must be impossible to mistake for something that is running.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface ServiceCardData extends Record<string, unknown> {
  name: string;
  typeName: string;
  kind: string;
  status: string;
  /** `null` means never deployed. Distinct from 0. */
  containers: number | null;
  ha: boolean;
  publicHttp: boolean;
  ports: number[];
  system: boolean;
  ghost?: boolean;
  reason?: string;
  confidence?: string;
}

const KIND_ICON: Record<string, string> = {
  runtime: '▶', database: '🗄', cache: '⚡', search: '🔍',
  queue: '📨', storage: '📦', system: '⚙', unknown: '◻',
};

/** Cap the glyphs so a 40-container service does not become a wall; the number still shows. */
const MAX_GLYPHS = 6;

export function ServiceCard({ data }: NodeProps) {
  const d = data as unknown as ServiceCardData;
  const ghost = d.ghost === true;
  const n = d.containers;

  return (
    <div className={`card ${ghost ? 'ghost' : ''} ${d.system ? 'system' : ''}`}>
      <Handle type="target" position={Position.Top} />

      <div className="containers">
        {n === null ? (
          // The honest empty state. Not zero glyphs silently -- a label saying why.
          <span className="undeployed">{ghost ? 'not provisioned' : 'not deployed'}</span>
        ) : (
          <>
            {Array.from({ length: Math.min(n, MAX_GLYPHS) }, (_, i) => <span key={i} className="glyph" />)}
            {n > MAX_GLYPHS && <span className="more">+{n - MAX_GLYPHS}</span>}
            {n === 0 && <span className="undeployed">0 containers</span>}
          </>
        )}
      </div>

      <div className="title">
        <span className="icon">{KIND_ICON[d.kind] ?? '◻'}</span>
        <span className="name">{d.name}</span>
      </div>
      <div className="type">{d.typeName}</div>

      <div className="badges">
        {d.ha && <span className="badge ha">HA</span>}
        {d.publicHttp && <span className="badge pub">public</span>}
        {d.ports.map((p) => <span key={p} className="badge port">:{p}</span>)}
        {ghost && <span className={`badge missing ${d.confidence === 'likely' ? 'weak' : ''}`}>
          {d.confidence === 'likely' ? 'maybe missing' : 'missing'}
        </span>}
      </div>

      {ghost && d.reason !== undefined && <div className="why">{d.reason}</div>}
      {!ghost && <div className={`status s-${d.status.toLowerCase().replace(/_/g, '-')}`}>{d.status}</div>}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
