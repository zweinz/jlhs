import type { SoloQuestionRecord } from './solo';

type Props = {
  record: SoloQuestionRecord;
  questionName: string;
  titleId?: string;
};

/** Shared by the immediate response sheet and the saved question card. */
export function SoloResponseNotice({ record, questionName, titleId }: Props) {
  if (record.outcome !== 'randomized' && record.outcome !== 'vetoed') return null;
  const randomized = record.outcome === 'randomized';
  const cardName = randomized ? 'Randomize question' : 'Veto question';
  const copied = record.playedCards?.some((announcement) =>
    announcement.includes(cardName) && announcement.includes('Duplicate another card'));
  return <section className={`solo-response-notice ${record.outcome}`} aria-label={`Xeno played ${cardName}`}>
    <div className="solo-response-notice-heading">
      <span className="solo-response-symbol" aria-hidden="true">{randomized ? '↔' : '✕'}</span>
      <div><span className="solo-response-kicker">Xeno played a card</span><h2 id={titleId}>{cardName}</h2></div>
    </div>
    {copied && <p className="solo-response-copy">Played using Duplicate another card</p>}
    <dl className="solo-response-questions">
      <div><dt>{randomized ? 'Original · not answered' : 'Vetoed · not answered'}</dt><dd><s>{record.randomizedFrom ?? questionName}</s></dd></div>
      {randomized && <div><dt>Replacement · answered below</dt><dd>{record.randomizedTo ?? questionName}</dd></div>}
    </dl>
    {!randomized && <p className="solo-response-explanation">No answer. No card reward. No map change. The question still counts as asked.</p>}
  </section>;
}
