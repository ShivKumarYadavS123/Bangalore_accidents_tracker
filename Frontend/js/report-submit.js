/**
 * report-submit.js — order of work when the report form is submitted.
 *
 * A live crash ("happening right now") raises the SOS first, on its own:
 * nothing in the report save (photo upload, validation, sign-in, server
 * errors, being offline) can delay or block it. The report is saved
 * afterwards whatever happened to the SOS, and both outcomes are returned
 * separately so the page can tell the user exactly what went through.
 */
(function (root) {
  'use strict';

  async function submit({ live, sendSos, saveReport }) {
    const out = { sos: null, sosError: null, report: null, reportError: null };
    if (live) {
      try { out.sos = await sendSos(); } catch (e) { out.sosError = e; }
    }
    try { out.report = await saveReport(); } catch (e) { out.reportError = e; }
    return out;
  }

  root.ReportSubmit = { submit };
}(typeof window !== 'undefined' ? window : globalThis));
