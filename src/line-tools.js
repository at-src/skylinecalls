// The tools Varun has on the line, as [name, description, properties, required]. One source for both the live Bolna
// agent (scripts/setup-agents.js) and the red-team eval (scripts/redteam.js), so the eval tests what's deployed.
const S = (description) => ({ type: 'string', description });
const N = S('caller_number from the call context');
export const LINE_DEFS = [
  ['lookup_caller', 'Who is calling. Call it FIRST, before saying anything else, with the caller_number from the call context.',
    { caller_number: N }, ['caller_number']],
  ['classify_caller', 'Sort the caller once they say who they are or why they called. Returns the rule, the time limit and any briefing to follow. For deliveries and cabs it also checks the order.',
    { caller_number: N, name: S('Their name, if they said'), org: S('Company or app they are from, e.g. LIC, Jio, Zepto'), purpose: S('Why they called, in their words'), guess: S('Your guess: close, vip, known, service, sales, delivery or unknown') }, ['caller_number', 'purpose']],
  ['check_passcode', 'Check the code a caller gives to reach the owner urgently. Pass only the digits they said.',
    { caller_number: N, code: S('The digits they said'), name: S('Who they say they are') }, ['caller_number', 'code']],
  ['take_message', 'Send the owner a message from the caller.',
    { caller_number: N, name: S('Who it is from'), message: S('The message, short, with any dates, times and amounts'), urgent: S('true if it is urgent') }, ['caller_number', 'message']],
  ['alert_owner', 'Alert the owner right now: something urgent, or an offer outside a briefing.',
    { caller_number: N, name: S('Who is calling'), reason: S('Why, in one line with any amounts') }, ['caller_number', 'reason']],
  ['set_reminder', 'The caller wants the owner to call back or be reminded of something at a time. You cannot place calls, so save a reminder; the owner gets a nudge at that time.',
    { caller_number: N, name: S('Who the reminder is about'), text: S('What to remind, e.g. "Call Rahul back about the quote"'), when: S('When, in their words: "6pm", "in 20 minutes", "tomorrow 9am"') }, ['text']],
  ['check_calendar', "Check whether the owner is free on a day, from his Google Calendar. Use when a caller asks if he's available or wants to set a time. The note says what you may share with this caller.",
    { caller_number: N, date: S('Which day, in the caller\'s words: today, tomorrow, kal, parso, a weekday like Monday, or YYYY-MM-DD. Leave empty for today. Never guess a date.') }, ['caller_number']],
  ['check_mail', "Check whether a mail the caller expects has reached the owner (e.g. an invoice, a confirmation). Read-only. The note says what you may share with this caller.",
    { caller_number: N, query: S('What to look for, in Gmail search terms, e.g. "from:zepto out for delivery".') }, ['caller_number']],
  ['end_call', 'Log the call before hanging up. Always call it once at the end.',
    { caller_number: N, name: S('Their name'), org: S('Their company'), kind: S('close, vip, known, service, sales, delivery or unknown'), summary: S('One line: what happened, with amounts and dates'), outcome: S('e.g. declined, message taken, agreed: rent by the 10th'), block: S('true for spam, sales or scams, to cut them off next time'), relation: S('Who they are to the owner, if they said') }, ['caller_number', 'summary']],
];
// OpenAI-style function definitions for the same tools (used by the eval)
export const openaiTools = (defs = LINE_DEFS) => defs.map(([name, description, properties, required]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }));
