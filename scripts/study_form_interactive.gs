/**
 * Builds the interactive CastleRAG user-study Google Form ("CastleRAG User
 * Study — Questionnaire (interactive version)"). Participants keep the form in
 * one tab and the live CastleRAG UI (scripts/slurm/ui_live.slurm behind a
 * Cloudflare tunnel) in another, and check each answer in the UI themselves.
 *
 * Run buildInteractiveForm() once. It creates the form in your Drive and logs
 * the edit and respondent links. The orientation image is copied from the
 * screenshot-version form (SCREENSHOT_FORM_ID), so nothing has to be uploaded.
 *
 * Before each session window, run setSession(formId, link, password) with the
 * tunnel link from logs/castle-ui-live_<jobid>.out. The repo never holds the
 * password; a quick tunnel gets a new link every run.
 */

const FORM_TITLE = 'CastleRAG user study (interactive)';
const SCREENSHOT_FORM_ID = '1a05u5rBYEpJU3X7I5dwLSIUrXEETtt6aQnhR3Sxb_bk';
const ORIENTATION_TITLE_PREFIX = '(1) Your question';

// Answers are CastleRAG's claims from the 2026-10-15 live capture
// (outputs/user_study/manifest.json). Generation runs at temperature 0, so the
// live UI should return the same text; re-check before the first session.
// role is for the analysis only and never shown to participants.
const TASKS = {
  practice: {
    question: 'What brand is the fridge in the kitchen?',
    answer: 'The fridge in the kitchen is a Samsung brand, as indicated by the visible logo on the upper right side of the refrigerator door.',
  },
  t1: {
    question: "What colour was the rim of Werner's plate during breakfast on the first day?",
    answer: "The rim of Werner's plate was yellow.",
    role: 'right, strong evidence',
  },
  t2: {
    question: 'What brand of tea was available?',
    answer: "Barry's Tea was available, as seen in multiple frames where its packaging is clearly visible in the kitchen and pantry. Lion brand tea was also present in the dining room cabinet.",
    role: 'right, strong evidence',
  },
  t3: {
    question: 'What was the first category in the happy quiz?',
    answer: 'The first category in the happy quiz was sport.',
    role: 'right, weakly supported',
  },
  t4: {
    question: 'What game did Bjorn suggest to play with the cameras?',
    answer: 'Bjorn suggested playing a card game with the cameras.',
    role: 'wrong, marked well supported',
  },
};

const ORDER_A = ['t1', 't2', 't3', 't4'];
const ORDER_B = ['t4', 't3', 't2', 't1'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const OPEN_TITLE = 'Open CastleRAG';
const SESSION_PLACEHOLDER = 'Open CastleRAG in a new tab: [link and password are added before each session]';

function buildInteractiveForm() {
  const form = FormApp.create(FORM_TITLE);
  form.setDescription(
    'CastleRAG is a research prototype that answers questions about recordings ' +
    'of a multi-day event filmed by wearable and room cameras, and shows the ' +
    'footage it used as evidence. You will use it yourself to check some of its ' +
    'answers. Keep this form open in one tab and CastleRAG in another. This ' +
    'takes about 25 to 30 minutes, and works best on a laptop.');
  form.setCollectEmail(false);
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(true);
  form.setShuffleQuestions(false);
  form.setAllowResponseEdits(false);
  form.setConfirmationMessage(
    'Thank you for taking part. One thing we could not say up front: some of ' +
    'the answers you checked were wrong on purpose, or only weakly backed by the ' +
    'footage, because we want to know whether the evidence helps people spot ' +
    'that. The correct answers: the plate rim was yellow, the tea was Barry\'s, ' +
    'the first quiz category was sport, and Bjorn suggested a game of Chicken, ' +
    'not a card game. Please do not tell other participants.');

  // Consent (first page, no page break before it).
  form.addSectionHeaderItem().setTitle('Before you start').setHelpText(
    'Your responses are anonymous: we do not collect names or email addresses. ' +
    'They will be analysed by the CastleRAG team at the University of Amsterdam ' +
    'and reported in aggregate in a research publication. CastleRAG keeps an ' +
    'anonymous log of what you do in it (questions asked, answers shown, cameras ' +
    'marked), linked to this form only by a random session code. The questions ' +
    'you type into CastleRAG are processed on a university compute server, so ' +
    'please do not type anything personal into it. You can stop at any time by ' +
    'closing this page; nothing is saved until you submit.');
  form.addCheckboxItem()
    .setTitle('Consent')
    .setChoiceValues(['I agree to take part, and to my anonymous responses and CastleRAG log being used in this research and its publication.'])
    .setRequired(true);

  // Open CastleRAG, with an exit for anyone who can't reach the live system.
  form.addPageBreakItem().setTitle(OPEN_TITLE).setHelpText(SESSION_PLACEHOLDER);
  const live = form.addMultipleChoiceItem()
    .setTitle('Once CastleRAG has loaded, what does the badge in its top bar say, next to "16 cams"?')
    .setRequired(true);
  // The session code lives past the live check: a required item on the same
  // page would block the jump to the exit page for people without a session.
  const orientation = form.addPageBreakItem().setTitle('How CastleRAG works')
    .setHelpText('Have a look around CastleRAG while you read this.');
  form.addTextItem().setTitle('Session code')
    .setHelpText('Copy the session code shown in CastleRAG\'s top bar. It links what you do in ' +
      'CastleRAG to this form without identifying you.')
    .setRequired(true);
  addOrientationImage_(form);
  form.addMultipleChoiceItem().setTitle('What does the yellow "Partial support" badge mean?')
    .setChoiceValues(['The answer is wrong', 'The footage only partly backs the answer',
      'The video has only partly loaded', "I don't know"]).setRequired(true);
  form.addMultipleChoiceItem().setTitle('The three videos side by side show...')
    .setChoiceValues(['Three different moments', 'The same moment, recorded by three cameras',
      'Three possible answers', "I don't know"]).setRequired(true);

  // Practice task (shared by both versions).
  addTask_(form, 'practice', 'Practice task',
    'This one is for practice and is not analysed. Take your time to look around.');

  // About you. Placed after the practice task: the birth-month answer
  // routes to version A or B when this page is left.
  form.addPageBreakItem().setTitle('About you');
  form.addMultipleChoiceItem().setTitle('Which best describes you?')
    .setChoiceValues(['BSc student', 'MSc student', 'PhD student or researcher', 'Working in industry'])
    .showOtherOption(true).setRequired(true);
  form.addMultipleChoiceItem().setTitle('How often do you use AI assistants such as ChatGPT or Claude?')
    .setChoiceValues(['Never', 'A few times a month', 'Weekly', 'Daily']).setRequired(true);
  form.addScaleItem().setTitle('How familiar are you with machine learning or search systems?')
    .setBounds(1, 5).setLabels('Not at all', 'I build them').setRequired(true);
  form.addMultipleChoiceItem().setTitle('Have you seen the CASTLE 2024 dataset or its videos before?')
    .setChoiceValues(['Yes', 'No']).setRequired(true);
  form.addMultipleChoiceItem().setTitle('Which device are you using?')
    .setChoiceValues(['Laptop or desktop', 'Tablet', 'Phone']).setRequired(true);
  const month = form.addListItem().setTitle('Your birth month')
    .setHelpText('Only used to decide the order in which you see the tasks.').setRequired(true);

  // Version A and B task chains. In Forms a jump is attached to the page
  // break that ends a section, so: chain A's last section ends at chain B's
  // first page break, which jumps to "own question"; chain B flows into it.
  const chainA = addChain_(form, ORDER_A, 'A');
  const chainB = addChain_(form, ORDER_B, 'B');

  const own = form.addPageBreakItem().setTitle('Your own question')
    .setHelpText('Press Clear in CastleRAG, then ask it one question of your own about the ' +
      'recordings: for example about meals, games, the presentations, or who did what. ' +
      'Then try to check the answer with the footage.');
  chainB.firstPage.setGoToPage(own);
  form.addTextItem().setTitle('[own] Your question').setRequired(true);
  form.addMultipleChoiceItem().setTitle('[own] As far as you could tell from the footage, was the answer correct?')
    .setChoiceValues(['Yes', 'Partly', 'No', "Couldn't tell"]).setRequired(true);
  form.addMultipleChoiceItem().setTitle('[own] How long did it take you to decide?')
    .setChoiceValues(['Under a minute', '1 to 3 minutes', '3 to 10 minutes', 'I gave up']).setRequired(true);
  form.addScaleItem().setTitle('[own] How confident are you in that judgement?')
    .setBounds(1, 7).setLabels('Guessing', 'Certain').setRequired(true);

  // Overall impression (UEQ-S): 7-point semantic differentials.
  form.addPageBreakItem().setTitle('Nearly done')
    .setHelpText('A few questions about CastleRAG overall. Rate it between each pair of words.');
  [['obstructive', 'supportive'], ['complicated', 'easy'], ['inefficient', 'efficient'],
   ['confusing', 'clear'], ['boring', 'exciting'], ['not interesting', 'interesting'],
   ['conventional', 'inventive'], ['usual', 'leading edge']].forEach(([l, r], i) =>
    form.addScaleItem().setTitle(`UEQ ${i + 1}: ${l} / ${r}`)
      .setBounds(1, 7).setLabels(l, r).setRequired(true));

  // Trust and usefulness.
  form.addPageBreakItem().setTitle('Trust and usefulness')
    .setHelpText('1 = strongly disagree, 7 = strongly agree.');
  ['I am confident in CastleRAG.', 'CastleRAG is reliable.', 'I can trust CastleRAG.',
   'CastleRAG is dependable.', "I am suspicious of CastleRAG's answers.", 'I am wary of CastleRAG.',
   'Seeing the footage made it clear why CastleRAG gave its answer.',
   'A tool like this would help me answer questions about long recordings faster than scrubbing through the video myself.',
   'Seeing several cameras at the same moment helped me judge the evidence.',
   'Marking cameras Confirm, Refine or Ignore was worth the extra effort.']
    .forEach(t => agree_(form, t));

  // Open questions.
  form.addPageBreakItem().setTitle('Your comments');
  ['What was most useful?', 'What was confusing or missing?',
   "When would you not trust CastleRAG's answer?",
   'Did anything go wrong technically, for example slow answers, videos that would not play, or the page not loading?',
   'Anything else?']
    .forEach(t => form.addParagraphTextItem().setTitle(t));

  // Exit page for anyone who can't reach the live system; the live-check
  // choices jump here. A page break's go-to applies on leaving the section
  // before it, so SUBMIT below makes the comments page end the form instead
  // of flowing into this one. As the last page, the exit page itself submits.
  const unavailable = form.addPageBreakItem().setTitle('CastleRAG is not available right now')
    .setHelpText('The live system is only up during announced session times. Please submit ' +
      'this page and try again in a later session.');
  unavailable.setGoToPage(FormApp.PageNavigationType.SUBMIT);
  live.setChoices([
    live.createChoice('live RAG', orientation),
    live.createChoice('offline', unavailable),
    live.createChoice("I can't open CastleRAG", unavailable),
  ]);

  // Birth month routing: odd months to A, even to B.
  month.setChoices(MONTHS.map((m, i) =>
    month.createChoice(m, i % 2 === 0 ? chainA.firstPage : chainB.firstPage)));

  Logger.log('Edit:    ' + form.getEditUrl());
  Logger.log('Respond: ' + form.getPublishedUrl());
  return form.getEditUrl();
}

function addChain_(form, order, version) {
  let firstPage = null, lastPage = null;
  order.forEach((key, idx) => {
    const pages = addTask_(form, key, `Task ${idx + 1} of 4`, '', `${version}-${key}`);
    if (!firstPage) firstPage = pages.first;
    lastPage = pages.last;
  });
  return { firstPage, lastPage };
}

/**
 * One task over three pages: judge the answer from the text alone, check it
 * in CastleRAG, then refine it there. tag prefixes item titles so A and B can
 * be merged in analysis.
 */
function addTask_(form, key, heading, note, tag) {
  const t = TASKS[key];
  const p = tag ? `[${tag}] ` : '[practice] ';
  const first = form.addPageBreakItem().setTitle(heading)
    .setHelpText((note ? note + '\n\n' : '') +
      'Someone asked CastleRAG: ' + t.question + '\n\nIt answered: ' + t.answer +
      '\n\nAnswer from this text alone; you will check it in CastleRAG on the next page.');
  form.addMultipleChoiceItem().setTitle(p + 'Do you think this answer is correct?')
    .setChoiceValues(['Yes', 'No', "Can't tell"]).setRequired(true);
  form.addScaleItem().setTitle(p + 'How confident are you?')
    .setBounds(1, 7).setLabels('Guessing', 'Certain').setRequired(true);

  form.addPageBreakItem().setTitle(heading + ': check it in CastleRAG')
    .setHelpText('Press Clear in CastleRAG\'s top bar, then paste this question and press Send:\n\n' +
      t.question + '\n\nAnswers take a little while. Then look at the evidence: click the ' +
      'moments in the answer, play the camera videos and compare the cameras. Take as long ' +
      'as you need; a few minutes is usually enough.');
  form.addMultipleChoiceItem().setTitle(p + 'Did CastleRAG give the same answer as on the previous page?')
    .setChoiceValues(['Yes, the same', 'A different answer', 'An error, or no answer']).setRequired(true);
  form.addCheckboxItem().setTitle(p + 'What did you do in CastleRAG?')
    .setChoiceValues(['Played at least one camera video', 'Looked at more than one evidence moment',
      'Clicked a camera name in the answer text', 'Looked at the camera match scores', 'None of these'])
    .setRequired(true);
  form.addMultipleChoiceItem().setTitle(p + 'Does the evidence back up the answer?')
    .setChoiceValues(['Yes', 'Partly', 'It contradicts it', "Can't tell"]).setRequired(true);
  form.addMultipleChoiceItem().setTitle(p + 'Now, do you think the answer is correct?')
    .setChoiceValues(['Yes', 'No', "Can't tell"]).setRequired(true);
  form.addScaleItem().setTitle(p + 'How confident are you now?')
    .setBounds(1, 7).setLabels('Guessing', 'Certain').setRequired(true);
  form.addMultipleChoiceItem().setTitle(p + 'What would you do next?')
    .setChoiceValues(['Accept the answer', 'Search again with a refined question', 'Reject the answer', 'Not sure'])
    .setRequired(true);
  form.addParagraphTextItem().setTitle(p + 'Why? (optional)');

  const last = form.addPageBreakItem().setTitle(heading + ': refine it')
    .setHelpText('In CastleRAG, mark each camera Confirm, Refine or Ignore. CastleRAG drafts a ' +
      'sharper search from your marks. Edit it if you like, then send it and look at the new answer.');
  form.addMultipleChoiceItem().setTitle(p + 'Did you send a refined search?')
    .setChoiceValues(['Yes', "No, I didn't think it was needed", "No, I couldn't work out how"])
    .setRequired(true);
  optionalAgree_(form, p + 'The drafted search reflected what I wanted.');
  optionalAgree_(form, p + 'After the refinement, I am more sure whether the original answer was right.');
  form.addScaleItem().setTitle(p + 'How mentally demanding was it to judge this answer?')
    .setBounds(1, 7).setLabels('Very low', 'Very high').setRequired(true);
  return { first, last };
}

function agree_(form, title) {
  form.addScaleItem().setTitle(title).setBounds(1, 7)
    .setLabels('Strongly disagree', 'Strongly agree').setRequired(true);
}

/** Refinement items: left optional so people who sent no refined search can skip them. */
function optionalAgree_(form, title) {
  form.addScaleItem().setTitle(title).setHelpText('Skip this if you did not send a refined search.')
    .setBounds(1, 7).setLabels('Strongly disagree', 'Strongly agree').setRequired(false);
}

function addOrientationImage_(form) {
  const src = FormApp.openById(SCREENSHOT_FORM_ID).getItems(FormApp.ItemType.IMAGE)
    .map(it => it.asImageItem())
    .find(it => it.getTitle().startsWith(ORIENTATION_TITLE_PREFIX));
  if (!src) {
    form.addSectionHeaderItem().setTitle('[screenshot: orientation.png]');
    return;
  }
  form.addImageItem().setImage(src.getImage()).setTitle(src.getTitle() +
    ' On a phone the panels sit below each other.');
}

function openPage_(formId) {
  const page = FormApp.openById(formId).getItems(FormApp.ItemType.PAGE_BREAK)
    .map(it => it.asPageBreakItem()).find(pb => pb.getTitle() === OPEN_TITLE);
  if (!page) throw new Error(`No page titled "${OPEN_TITLE}" in form ${formId}; was it built by buildInteractiveForm()?`);
  return page;
}

/**
 * Puts the current tunnel link and password on the "Open CastleRAG" page.
 * Run before each session window; a quick tunnel gets a new link every run.
 */
function setSession(formId, link, password) {
  openPage_(formId).setHelpText(
    `Open CastleRAG in a new tab: ${link}\n\n` +
    `Log in with username study and password ${password}\n\n` +
    'Use a private or incognito window if you have opened CastleRAG before, so you ' +
    'start with an empty conversation. The first page can take a few seconds to load.');
  Logger.log('Session set: ' + link);
}

/** Puts the placeholder back after a session, so the form never shows a stale link. */
function clearSession(formId) {
  openPage_(formId).setHelpText(SESSION_PLACEHOLDER);
}

/** Logs every page and where it routes, to check the branching of a built form. */
function checkRouting(formId) {
  const form = FormApp.openById(formId);
  const out = [];
  form.getItems().forEach(it => {
    if (it.getType() === FormApp.ItemType.PAGE_BREAK) {
      const pb = it.asPageBreakItem(); const g = pb.getGoToPage(); const n = pb.getPageNavigationType();
      out.push(`PAGE ${it.getIndex()} "${pb.getTitle()}"` +
        (g ? ` | arriving linearly jumps to ${g.getIndex()} "${g.getTitle()}"` : '') +
        (n && n !== FormApp.PageNavigationType.CONTINUE ? ` | nav ${n}` : ''));
    }
    const choiceItem = it.getType() === FormApp.ItemType.LIST ? it.asListItem()
      : it.getType() === FormApp.ItemType.MULTIPLE_CHOICE ? it.asMultipleChoiceItem() : null;
    if (choiceItem) {
      choiceItem.getChoices().forEach(c => {
        if (c.getGotoPage()) out.push(`  ${c.getValue()} -> ${c.getGotoPage().getIndex()} ${c.getGotoPage().getTitle()}`);
      });
    }
  });
  out.push('items: ' + form.getItems().length);
  Logger.log(out.join('\n'));
}
