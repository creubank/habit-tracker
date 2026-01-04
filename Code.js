/*
 * Copyright (c) 2026 Curtis Eubanks
 * Licensed under the MIT License. See LICENSE in the project root for details.
 */

/*
 * Current version matching the Google Apps Deployment version.
 * Manually update immediate before deployment to keep in sync.
 */
const APP_VERSION = '0.22';

/*
 * Habit Grid → JSON via Gemini
 *
 * This project turns a photo of a handwritten weekly habit tracker into
 * clean, structured JSON that can be consumed by other systems.
 *
 * High-level flow:
 * 
 * - An iOS Shortcut captures or selects a photo of a whiteboard or
 *   paper-based habit grid, then Base64-encodes the image and POSTs
 *   it to this Google Apps Script endpoint.
 * 
 * - The doPost handler validates the request, normalizes the image
 *   payload, and forwards the image plus a carefully engineered prompt
 *   to the Gemini API (e.g., gemini-2.5-flash).
 * 
 * - Gemini performs multimodal understanding of the grid: it reads the
 *   handwritten week label and daily cells, interprets checkmarks,
 *   Xs, blanks, and numeric values for each configured habit.
 * 
 * - Gemini returns a single JSON object describing:
 *     • week_start_date (MM/DD/YYYY)
 *     • an array of habit records, each with a habit name and a
 *       per-day values array (numbers, 0/1 flags, or nulls).
 * - The script parses this JSON and returns it as the HTTP response,
 *   so the Shortcut (or any other client) can persist, analyze, or
 *   visualize the data without doing its own OCR or parsing.
 *
 * Design goals:
 * - Keep the on-device Shortcut as simple as possible: just capture the
 *   image and forward it.
 * 
 * - Centralize all model interaction, prompt logic, and error handling
 *   in Apps Script for easier debugging and iteration.
 * 
 * - Produce predictable, machine-friendly JSON from messy handwritten
 *   inputs, enabling downstream habit analytics, dashboards, and exports.
 */

// --- CONFIGURATION ---
const GEMINI_API_KEY    =  PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const SHEET_NAME_WEEKLY = 'Weekly View'; // Weekly grid tab
const SHEET_NAME_HABITS = 'Habit List';  // Sheet containing Habit List Table

if (!GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is not set in Script Properties.');
}

// JSON Schema describing the normalized habit data shape that Gemini must return.
//
// Why this exists:
// - We use Gemini's structured output mode (responseMimeType + responseJsonSchema)
//   to force the model to emit strict, machine-parseable JSON instead of free-form
//   text or markdown.
// - These schemas define the exact contract between the model and our code so that
//   downstream parsing and validation are reliable.
//
// habitSchema:
// - Shape of a single habit entry (name + per-day values).
// - Used as a building block in habitResponseSchema.
// - `habit`: the habit name as a string (e.g., "Weight (lbs)").
// - `values`: an array where each element is either a number or null.
//   • Numbers cover both numeric measurements and boolean 0/1 flags.
//   • null represents blank or future cells.
//
// habitResponseSchema:
// - Defines the structure of the final weekly habit object that our downstream
//   systems consume.
// - `week_start_date`: week label as a string in MM/DD/YYYY form.
// - `data`: an array of habit entries, each following habitSchema.
// - Both `week_start_date` and `data` are required so callers can rely on
//   them always being present.

// *************************************************
// *** STRUCTURED OUTPUT MODE SOLUTION (ON HOLD) ***
// *************************************************
// const habitSchema = {
//   type: 'object',
//   properties: {
//     habit: { type: 'string' },
//     values: {
//       type: 'array',
//       items: { type: ['number', 'null'] }
//     }
//   },
//   required: ['habit', 'values'],
// };
// 
// const habitResponseSchema = {
//   type: 'object',
//   properties: {
//     week_start_date: { type: 'string' },
//     data: {
//       type: 'array',
//       items: habitSchema,
//     },
//   },
//   required: ['week_start_date', 'data'],
// };

// --- LOGGING TO GOOGLE SHEETS ---
function getLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Log') || ss.insertSheet('Log');
  return sheet;
}

function log_(msg) {
  const sh = getLogSheet_();
  sh.appendRow([new Date(), String(msg)]);
}

function clearLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Log');
  if (!sheet) return;  // nothing to clear

  // Remove all content and formatting on the Log sheet
  sheet.clear();   // or sheet.clearContents() if you want to keep formatting
}

// --- OTHER HELPER FUNCTIONS ---
/*
 * Helper function to parse date
 */
function parseMmDdYyyy(str) {
  const [mm, dd, yyyy] = str.split('/').map(Number);
  return new Date(yyyy, mm - 1, dd);
}

/*
 * Helper function to find the first instance of a date in a sheet
 */
function findFirstDateMatch(sheet, targetDate) {
  const worksheetRange = sheet.getDataRange();
  const cellValues = worksheetRange.getValues();

  // Normalize target date to midnight
  const t = new Date(targetDate);
  t.setHours(0, 0, 0, 0);

  for (let r = 0; r < cellValues.length; r++) {
    for (let c = 0; c < cellValues[r].length; c++) {
      const v = cellValues[r][c];
      if (v instanceof Date) {
        const d = new Date(v);
        d.setHours(0, 0, 0, 0);
        if (d.getTime() === t.getTime()) {
          // First match in current sheet
          return { row: r + 1, column: c + 1 };
        }
      }
    }
  }
  return null; // not found
}

/*
 * Utility function to get a better "type" description for a javascript reference.
 * (Why doesn't javascript provide a built-in function to do this?)
 */
function getType(value) {
  const type = typeof value;
  if (type !== 'object') return type; // 'string', 'number', etc.

  if (value === null) return 'null';

  // e.g. 'Array', 'Date', 'RegExp', 'Object'
  return Object.prototype.toString.call(value).slice(8, -1);
}

/*
 * Added doGet even though we don't use it because the iOS Shortcut sometimes uses the
 * GET instead of POST even when we specified POST. Our doGet() helps us to identify
 * and fix that particular bug.
 */
function doGet(e) {
  return ContentService.createTextOutput('GET request received. Use POST with JSON body containing "image" field.');
}

function doPost(e) {
  try {
    log_('doPost:start');

    if (!e || !e.postData) {
      throw new Error('No data received');
    }
    
    const raw = e.postData.contents;
    const postData = JSON.parse(raw);

    // Original value from Shortcuts
    const img = postData.image;

    // Normalized value we will send to Gemini
    let base64Image = img;
    let imgRefType = getType(base64Image);
    log_('doPost:RAW TYPE: ' + imgRefType);

    /* one-time debug logic */
    if (typeof base64Image === 'object' && base64Image !== null) {
      log_('doPost:image keys: ' + Object.keys(base64Image).join(','));
      base64Image = base64Image.base64 || base64Image.data || null;
      imgRefType = getType(base64Image);
    }
    
    if (imgRefType !== 'string') {
      log_('doPost:image payload dump: ' + JSON.stringify(img).substring(0, 200));
      throw new Error(`base64Image has wrong type: ${imgRefType} instead of string`);
    }

    base64Image = String(base64Image)
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
      .trim();

    imgRefType = getType(base64Image); 
    log_('doPost:NORM TYPE: ' + imgRefType +
         ', NORM LEN: ' + String(base64Image || '').length);
    
    // Normal processing
    const { habitNamesString, jsonTypesString, habitsArray } = getHabitMetadata();
	  log_('doPost:habitsArray length: ' + habitsArray.length);

	  const analysis = callGemini(base64Image, habitNamesString, jsonTypesString, habitsArray);

    // Log the analysis results for a while for manual review
    log_('doPost:analysis JSON: ' + JSON.stringify(analysis, null, 2));
    log_('doPost:analysis.week_start_date: ' + String(analysis && analysis.week_start_date));

    const result = updateSheet(analysis);
    log_('doPost:updateSheet result: ' + result);

    return ContentService.createTextOutput(result);
    
  } catch (error) {
    log_('doPost:ERROR: ' + error.toString());
    return ContentService.createTextOutput('Error: ' + error.toString());
  }
}

/*
 * Reads Habit Name (col A), Excel Type (col B), JSON Type (col C), Example Values (col D)
 * from Habit List sheet and returns:
 *  - habitNamesString: ''Weight (lbs)', 'Meds/Supplements', ...'
 *  - jsonTypesString:  ''number', 'boolean', 'boolean', ...'
 *  - habitsArray:      [{name: 'Weight (lbs)', jsonType: 'number', examples: '[191.3, null, ...]'}, ...]
 */
function getHabitMetadata() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME_HABITS);
  if (!sheet) throw new Error(`Sheet '${SHEET_NAME_HABITS}' not found.`);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Habit List sheet has no data.');

  // Read columns A–D starting at row 2
  const range = sheet.getRange(2, 1, lastRow - 1, 4); // A2:D?
  const values = range.getValues(); // [[Habit, ExcelType, JSONType, Examples], ...]

  const habitsArray = values
    .filter(row => row[0]) // require Habit Name
    .map(row => ({
      name: String(row[0]).trim(),
      excelType: String(row[1]).trim(),  // Not used in prompt, but available
      jsonType: String(row[2]).trim(),   // 'number', 'boolean', etc.
      examples: String(row[3]).trim()    // '[191.3, null, 190.7, ...]'
    }));

  const habitNamesString = habitsArray
    .map(h => `'${h.name.replace(/'/g, '\\\'')}'`)
    .join(', ');
  
  const jsonTypesString = habitsArray
    .map(h => `'${h.jsonType.replace(/'/g, '\\\'')}'`)
    .join(', ');
  
  return { habitNamesString, jsonTypesString, habitsArray };
}

function callGemini(base64Image, habitNames, jsonTypes, habitsArray) {
  const MODEL = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`; 

  // *******************************************
  // *** POST-PROCESS OUTPUT SOLUTION (HACK) ***
  // *******************************************
  const promptText =
`You are processing a handwritten weekly habit tracker grid.

Tasks:
1. Identify the "WEEK" start date (e.g., "12/28").
   - Except for the "December" days in week 1 which occur in 2025,
     assume the year is 2026 for all other weeks.
2. For each of these habits, extract one value per day from the grid,
   in order: ${habitNames}.
   - The corresponding JSON field types are, in order: ${jsonTypes}.
3. Return ONLY a JSON object with this structure:

{
  "week_start_date": "MM/DD/YYYY",
  "data": [
    { "habit": "Weight (lbs)", "values": [191.3, null, ...] },
    { "habit": "Meds/Supplements", "values": [1, 0, null, ...] },
    { "habit": "Opto-kinetic", "values": [1, 0, null, ...] },
    { "habit": "Flossing", "values": [1, 0, null, ...] },
    { "habit": "Run (miles)", "values": [13.1, 6.21, null, ...] },
    { "habit": "Caffeine (mg)", "values": [111, 25, null, ...] },
    { "habit": "Tidy Office (min)", "values": [10, 15, null, ...] },
    { "habit": "DCSS", "values": [1, 0, null, ...] }
  ]
}

Rules:
- For boolean habits: use 1 for checked/done, 0 for X/missed.
- For numeric habits: use the actual numeric value (e.g., 191.3, 111).
- Use null if the cell is completely blank or in the future.
- Do not add explanations or comments.
- Do not wrap the JSON in markdown or code fences.`;

  // log_(`callGemini: promptText=${promptText}`);

  const payload = {
    contents: [{
      parts: [
        { text: promptText },
        { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
      ]
    }]
  };

  // *************************************************
  // *** STRUCTURED OUTPUT MODE SOLUTION (ON HOLD) ***
  // *************************************************
  //    const promptText =
  //  `You are processing a handwritten weekly habit tracker grid.
  //  
  //  Tasks:
  //  1. Identify the "WEEK" start date (e.g., "12/28").
  //     - Except for the "December" days in week 1 which occur in 2025,
  //       assume the year is 2026 for all other weeks.
  //  2. For each of these habits, extract one value per day from the grid,
  //     in order: ${habitNames}.
  //     - The corresponding JSON field types are, in order: ${jsonTypes}.
  //  3. Populate the JSON fields defined by the provided schema (week_start_date and data[].habit / data[].values).
  //  
  //  Rules:
  //  - For boolean habits: use 1 for checked/done, 0 for X/missed.
  //  - For numeric habits: use the actual numeric value (e.g., 191.3, 111).
  //  - Use null if the cell is completely blank or in the future.`;
  //  
  //    log_(`callGemini: promptText=${promptText}`);
  //  
  //  const payload = {
  //    contents: [{
  //      parts: [
  //        { text: promptText },
  //        { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
  //      ]
  //    }],
  //    generationConfig: {
  //      responseMimeType: 'application/json',
  //      responseJsonSchema: habitResponseSchema,
  //    },
  //  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const json = JSON.parse(response.getContentText());

  if (json.error) {
    throw new Error('Gemini API Error: ' + json.error.message);
  }

  const textResponse = json.candidates[0].content.parts[0].text;

  // *******************************************
  // *** POST-PROCESS OUTPUT SOLUTION (HACK) ***
  // *******************************************
  //
  // Remove ```json fences for textrendering if Gemini adds
  // them, thinking we are a web browser rather than a program.
  const cleanTextResponse = textResponse
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  return JSON.parse(cleanTextResponse);

  // *************************************************
  // *** STRUCTURED OUTPUT MODE SOLUTION (ON HOLD) ***
  // *************************************************
  // return JSON.parse(textResponse);
}

function updateSheet(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME_WEEKLY);
  if (!sheet) throw new Error(`Sheet '${SHEET_NAME_WEEKLY}' not found.`);

  if (!data) {
    throw new Error('updateSheet error: data object is null/undefined.');
  }

  if (!data.week_start_date) {
    throw new Error('updateSheet error: week_start_date is missing. Full data: ' + JSON.stringify(data));
  }

  const targetDate = parseMmDdYyyy(data.week_start_date);
  const match = findFirstDateMatch(sheet, targetDate);
  Logger.log('updateSheet:TARGET DATE: ' + targetDate.toISOString());
  Logger.log('updateSheet:MATCH: ' + JSON.stringify(match));

  if (!match) {
    return 'Error: Could not find week starting ' + data.week_start_date + ' in sheet "' + sheet.getName() + '".';
  }

  const startRow = match.row;

  let updates = 0;

  const startColumn = 1;
  const habitColumnIndex = 1;
  const lastRow = sheet.getLastRow();
  const rowCount = lastRow - startRow + 1;
  const searchRange = sheet.getRange(startRow, startColumn, rowCount, habitColumnIndex);

  data.data.forEach(item => {
    const habitFinder = searchRange.createTextFinder(item.habit);
    const habitCell = habitFinder.findNext();

    if (habitCell) {
      const r = habitCell.getRow();
      let rowValues = item.values || [];
      if (rowValues.length > 7) rowValues = rowValues.slice(0, 7);
      while (rowValues.length < 7) rowValues.push(null);

      sheet.getRange(r, 3, 1, 7).setValues([rowValues]); // C–I
      updates++;
    }
  });

  return `Success! Updated ${updates} habits for week of ${data.week_start_date}`;
}
