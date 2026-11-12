package io.github.jefdiesel.logosnode

/**
 * The start-up of the node, from its own log lines, for the Node screen: which replay the patched node
 * chose and why (its own reason text), how many stored blocks it replayed, and when it was Following.
 * Plain string handling, no regular expressions.
 */
object ReplayInfo {
    /** A line for the screen if `line` is one of the start-up milestones, else null. `ms`: since the start. */
    fun fromLine(line: String, ms: Long): String? {
        val at = String.format(java.util.Locale.US, "at +%.1f s", ms / 1000.0)
        return when {
            line.contains("replay mode chosen: ") -> {
                val rest = line.substringAfter("replay mode chosen: ")
                val reason = rest.substringBefore(" replay_verification=").trim()
                val mode = rest.substringAfter("replay_verification=", "").trim('"', ' ').substringBefore(' ').trim('"')
                "Restart check: ${mode.ifEmpty { "?" }} ($reason)"
            }
            line.contains("stored blocks to replay") ->
                "Found ${numberBefore(line, " stored blocks to replay")} stored blocks to replay ($at)"
            line.contains(" blocks replayed") ->
                "${numberBefore(line, " blocks replayed")} blocks replayed ($at)"
            line.contains("replay marker written") -> "Replay marker written: later starts replay fast"
            line.contains("could not write the replay marker") -> "Couldn't write the replay marker: the next start replays in full again"
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
