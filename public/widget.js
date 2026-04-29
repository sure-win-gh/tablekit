/*!
 * TableKit booking widget loader.
 *
 * Mounts an iframe pointing at <host>/embed/<venueId> next to the
 * <script> tag that loaded this file. Listens for height messages
 * from the iframe and resizes accordingly. No cookies, no PII, no
 * third-party calls.
 *
 * Snippet:
 *   <script
 *     src="https://book.tablekit.uk/widget.js"
 *     data-venue-id="<uuid>"
 *     async
 *   ></script>
 */
(function () {
  if (window.__tablekit_loaded__) return;
  window.__tablekit_loaded__ = true;

  var me = document.currentScript;
  if (!me) return;

  var venueId = me.getAttribute("data-venue-id");
  if (!venueId) return;

  // data-host overrides the script's own origin (handy for staging
  // embeds pointing at production, etc.). Default: same origin as
  // the loader script itself.
  var host;
  try {
    host = me.getAttribute("data-host") || new URL(me.src).origin;
  } catch (_) {
    return;
  }

  var frameId =
    me.getAttribute("data-frame-id") ||
    "tk-" + Math.random().toString(36).slice(2, 10);

  var iframe = document.createElement("iframe");
  iframe.src =
    host + "/embed/" + encodeURIComponent(venueId) + "#frameId=" + encodeURIComponent(frameId);
  iframe.title = "Book a table";
  iframe.style.cssText =
    "width:100%;border:0;display:block;background:transparent;min-height:200px";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("allow", "payment"); // required for Stripe + 3DS
  iframe.dataset.tkFrameId = frameId;

  if (me.parentNode) {
    me.parentNode.insertBefore(iframe, me.nextSibling);
  }

  window.addEventListener("message", function (e) {
    if (e.source !== iframe.contentWindow) return;
    var data = e.data;
    if (!data || data.type !== "tablekit:resize") return;
    if (data.frameId !== frameId) return;
    var h = Math.max(200, Math.min(4000, Number(data.height) || 0));
    iframe.style.height = h + "px";
  });
})();
