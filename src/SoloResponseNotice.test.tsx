import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SoloResponseNotice } from './SoloResponseNotice';
import type { SoloQuestionRecord } from './solo';

const record: SoloQuestionRecord = { id: 'q', displayText: 'Yes', repetition: 1, cardsDrawn: 1, cardsKept: 1 };

describe('response-card notices', () => {
  it('names Randomize prominently and distinguishes the original from the replacement', () => {
    const html = renderToStaticMarkup(<SoloResponseNotice questionName="Photo" record={{ ...record, outcome: 'randomized', randomizedFrom: 'Photo · Widest street', randomizedTo: 'Photo · Place of worship' }} />);
    expect(html).toContain('aria-label="Xeno played Randomize question"');
    expect(html).toContain('<h2>Randomize question</h2>');
    expect(html).toContain('<s>Photo · Widest street</s>');
    expect(html).toContain('Replacement · answered below');
    expect(html).toContain('<dd>Photo · Place of worship</dd>');
  });

  it('names Veto prominently, labels the dialog, and explains its consequences', () => {
    const html = renderToStaticMarkup(<SoloResponseNotice titleId="solo-answer-title" questionName="Radar · 1 mi" record={{ ...record, outcome: 'vetoed', cardsDrawn: 0, cardsKept: 0 }} />);
    expect(html).toContain('<h2 id="solo-answer-title">Veto question</h2>');
    expect(html).toContain('<s>Radar · 1 mi</s>');
    expect(html).toContain('No answer. No card reward. No map change.');
    expect(html).toContain('The question still counts as asked.');
    expect(html).not.toContain('Replacement');
  });

  it.each(['vetoed', 'randomized'] as const)('keeps Duplicate attribution visible for %s', (outcome) => {
    const name = outcome === 'vetoed' ? 'Veto question' : 'Randomize question';
    const html = renderToStaticMarkup(<SoloResponseNotice questionName="Radar" record={{ ...record, outcome, playedCards: [`Xeno played ${name} using Duplicate another card.`] }} />);
    expect(html).toContain('Played using Duplicate another card');
  });

  it('renders no response-card notice for an ordinary answer', () => {
    expect(renderToStaticMarkup(<SoloResponseNotice questionName="Radar" record={record} />)).toBe('');
  });
});
