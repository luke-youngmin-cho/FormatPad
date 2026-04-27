import { RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { GutterMarker, gutter } from '@codemirror/view';

const setGitHunks = StateEffect.define();

class GitHunkMarker extends GutterMarker {
  constructor(kind, hunk) {
    super();
    this.kind = kind;
    this.hunk = hunk;
  }

  eq(other) {
    return other.kind === this.kind && other.hunk?.id === this.hunk?.id;
  }

  toDOM(view) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = `cm-git-marker cm-git-${this.kind}`;
    marker.title = 'Git change. Click to revert this hunk.';
    marker.setAttribute('aria-label', `Git ${this.kind} hunk`);
    marker.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dom.dispatchEvent(new CustomEvent('orpad-git-revert-hunk', {
        detail: { hunk: this.hunk },
        bubbles: true,
      }));
    });
    return marker;
  }
}

function markerKind(type) {
  if (type === 'deleted') return 'deleted';
  if (type === 'modified') return 'modified';
  return 'added';
}

function buildMarkers(state, hunks) {
  const builder = new RangeSetBuilder();
  const seen = new Set();
  for (const hunk of hunks || []) {
    for (const marker of hunk.markers || []) {
      const lineNumber = Math.max(1, Math.min(state.doc.lines, marker.line || hunk.newStart || 1));
      const key = `${lineNumber}:${markerKind(marker.type)}:${hunk.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = state.doc.line(lineNumber);
      builder.add(line.from, line.from, new GitHunkMarker(markerKind(marker.type), hunk));
    }
  }
  return builder.finish();
}

export const gitHunkGutter = [
  StateField.define({
    create() {
      return RangeSet.empty;
    },
    update(value, transaction) {
      let next = value.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(setGitHunks)) next = buildMarkers(transaction.state, effect.value);
      }
      return next;
    },
    provide(field) {
      return gutter({
        class: 'cm-git-gutter',
        markers: (view) => view.state.field(field),
      });
    },
  }),
];

export function updateGitHunkGutter(view, hunks) {
  if (!view) return;
  view.dispatch({ effects: setGitHunks.of(hunks || []) });
}
