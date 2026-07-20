import {
  createPatternLabExperimentalDescriptor,
  validatePatternLabExperimentalDescriptor,
} from '../lib/patternLabExperimental.js';

const FEATURE_COPY = {
  advancedGraph: {
    title: 'Advanced graph bake',
    detail: 'Graph sources must lower into the bounded Recipe model or render to an LWSEQ sequence.',
    action: 'Prepare graph bake',
  },
  shaderBake: {
    title: 'Shader bake',
    detail: 'Shaders render in Studio and leave only a bounded Recipe or LWSEQ artifact for delivery.',
    action: 'Prepare shader bake',
  },
};

function BakeGate({ feature, copy, onPrepare }) {
  return (
    <section aria-labelledby={`plab-experimental-${feature.id}`}>
      <h3 id={`plab-experimental-${feature.id}`}>{copy.title}</h3>
      <p>{copy.detail} Arbitrary graph, GLSL, and JavaScript never run card-native.</p>
      <p><strong>{feature.enabled ? 'Experimental gate enabled' : 'Disabled'}</strong> · Bake only</p>
      {feature.enabled && (
        <button type="button" className="btn" disabled={!onPrepare} onClick={() => onPrepare?.(feature)}>
          {copy.action}
        </button>
      )}
    </section>
  );
}

export default function PatternLabExperimental({
  descriptor,
  flags,
  onAdvancedGraph,
  onShaderBake,
  onStudioRecord,
}) {
  const experimental = descriptor
    ? validatePatternLabExperimentalDescriptor(descriptor)
    : createPatternLabExperimentalDescriptor(flags);
  const enabledCount = Object.values(experimental.flags).filter(Boolean).length;
  const cardRecording = experimental.features.cardArtnetRecord;

  return (
    <details className="plab-advanced plab-experimental" data-testid="pattern-lab-experimental">
      <summary>
        Experimental tools
        <span>{enabledCount ? `${enabledCount} gated` : 'Off by default'}</span>
      </summary>

      <p>
        These gates expose no feature runtime until explicitly enabled. Card delivery always receives a bounded
        Recipe or an LWSEQ sequence, never editor source.
      </p>

      <BakeGate
        feature={experimental.features.advancedGraph}
        copy={FEATURE_COPY.advancedGraph}
        onPrepare={onAdvancedGraph}
      />
      <BakeGate
        feature={experimental.features.shaderBake}
        copy={FEATURE_COPY.shaderBake}
        onPrepare={onShaderBake}
      />

      <section aria-labelledby="plab-experimental-recording">
        <h3 id="plab-experimental-recording">Art-Net recording</h3>
        <p>Known Studio render frames are the first recording path and may be packaged as LWSEQ.</p>
        {cardRecording.enabled && (
          <button type="button" className="btn" disabled={!onStudioRecord} onClick={() => onStudioRecord?.(cardRecording)}>
            Describe Studio frame recording
          </button>
        )}
        <p><strong>Card-side recording is unavailable.</strong> Hardware approval is still required for:</p>
        <ul>
          {cardRecording.hardwareGates.map(gate => <li key={gate.id}>{gate.label}</li>)}
        </ul>
      </section>
    </details>
  );
}
