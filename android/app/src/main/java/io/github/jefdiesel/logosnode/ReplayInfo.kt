package io.github.jefdiesel.logosnode

/**
 * The start-up of the node, from its own log lines, for the Node screen: which replay the patched node
 * chose and why (its own reason text), how many stored blocks it replayed fast and how many in full,
 * and when it was Following. Plain string handling, no regular expressions.
 */
object ReplayInfo {
    /** A line for the screen if `line` is one of the start-up milestones, else null. `ms`: since the start. */
    fun fromLine(line: String, ms: Long): String? {
        val at = String.format(java.util.Locale.US, "at +%.1f s", ms / 1000.0)
        return when {
            line.contains("replay mode chosen: ") -> {
                // the node's own reason, without the structured fields after it
                var reason = line.substringAfter("replay mode chosen: ")
                for (field in listOf(" vouched_tip=", " replay_verification=", " marker=")) reason = reason.substringBefore(field)
                reason = reason.trim()
                val oldMode = line.substringAfter("replay_verification=", "").trim('"', ' ').substringBefore(' ').trim('"')
                when {
                    oldMode.isNotEmpty() -> "Restart check: $oldMode ($reason)"              // the first patch build
                    reason.startsWith("full replay") -> "Restart check: full (${reason.removePrefix("full replay").trimStart(':', ' ').ifEmpty { "asked for" }})"
                    else -> "Restart check: fast where already verified ($reason)"
                }
            }
            line.contains("replay timing (") -> {
                // "replay timing (1000 blocks: 990 fast, 10 with full verification): load …, apply …"
                val inner = line.substringAfter("replay timing (").substringBefore(")")
                val n = inner.substringBefore(" blocks").trim()
                val fast = inner.substringAfter(": ", "").substringBefore(" fast").trim()
                val full = inner.substringAfter("fast, ", "").substringBefore(" with full").trim()
                if (fast.isNotEmpty() && full.isNotEmpty()) "Replayed $n blocks: $fast fast, $full in full ($at)" else null
            }
            line.contains("stored blocks to replay") ->
                "Found ${numberBefore(line, " stored blocks to replay")} stored blocks to replay ($at)"
            line.contains(" blocks replayed") ->
                "${numberBefore(line, " blocks replayed")} blocks replayed ($at)"
            line.contains("replay marker written") -> "Replay marker written: later starts replay fast"
            line.contains("could not write the replay marker") -> "Couldn't write the replay marker: the next start replays in full"
            line.contains("entering Following phase") -> "Following the chain ($at)"
            else -> null
        }
    }

    /** What the screen says before any of those lines, and for the unpatched node, which logs no choice. */
    fun summary(lines: List<String>, variant: String): List<String> =
        if (lines.isEmpty()) emptyList()
        else if (lines.none { it.startsWith("Restart check:") } && variant != "patched") listOf("Restart check: full (official node, unpatched)") + lines
        else lines

    private fun numberBefore(line: String, marker: String): String =
        line.substringBefore(marker).takeLastWhile { it.isDigit() }.ifEmpty { "?" }
}
