package io.github.jefdiesel.logosnode

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Android's regex engine (ICU) refuses patterns that Java's accepts, such as a bare '}' or ']'; one
 * stopped the messaging supervisor on the phone while every JVM test passed. This finds every
 * Regex("...") in the app's sources and fails on what ICU may reject: an unescaped ']' outside a
 * character class, '[' inside one, or '{' / '}' anywhere except a {n}, {n,} or {n,m} quantifier.
 */
class RegexSafetyTest {
    private val literal = Regex("\"\"\"(.*?)\"\"\"|\"((?:\\\\.|[^\"\\\\])*)\"", RegexOption.DOT_MATCHES_ALL)

    @Test fun everyAppRegexIsSafeForAndroid() {
        val sources = File("src/main/java").walkTopDown().filter { it.extension == "kt" }.toList()
        assertTrue("no sources found from ${File(".").absolutePath}", sources.isNotEmpty())
        val problems = mutableListOf<String>()
        var checked = 0
        for (file in sources) {
            val text = file.readText()
            var at = text.indexOf("Regex(")
            while (at >= 0) {
                val m = literal.find(text, at + 6)
                if (m != null && m.range.first <= at + 8) {
                    val pattern = m.groups[1]?.value ?: unescapeKotlin(m.groups[2]!!.value)
                    checked++
                    icuProblem(pattern)?.let { problems += "${file.name}: /$pattern/: $it" }
                }
                at = text.indexOf("Regex(", at + 6)
            }
        }
        assertTrue("found no Regex(...) at all; the scan is broken", checked > 3)
        assertTrue(problems.joinToString("\n"), problems.isEmpty())
    }

    @Test fun theCheckCatchesWhatBrokeThePhone() {
        assertTrue(icuProblem("""\[runner] status""") != null)
        assertTrue(icuProblem("""bytes\{[^}]*}\s+""") != null)
        assertTrue(icuProblem("""^\d{1,6}(s|m|h)$""") == null)
        assertTrue(icuProblem("""\[runner\] metric x\{[^\}]*\}""") == null)
    }

    private fun unescapeKotlin(s: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                val n = s[i + 1]
                when (n) {
                    'u' -> { out.append(s.substring(i + 2, i + 6).toInt(16).toChar()); i += 6; continue }
                    'n' -> out.append('\n'); 't' -> out.append('\t'); 'r' -> out.append('\r')
                    else -> out.append(n)
                }
                i += 2
                continue
            }
            out.append(c); i++
        }
        return out.toString()
    }

    private val quantifier = Regex("^\\{\\d+(,\\d*)?\\}")

    private fun icuProblem(p: String): String? {
        var inClass = false
        var i = 0
        while (i < p.length) {
            val c = p[i]
            when {
                c == '\\' -> { i += 2; continue }
                inClass && c == ']' && !(p.getOrNull(i - 1) == '[' || (p.getOrNull(i - 1) == '^' && p.getOrNull(i - 2) == '[')) -> inClass = false
                inClass && c == '[' -> return "unescaped '[' inside a character class"
                inClass && (c == '{' || c == '}') -> return "unescaped '$c' inside a character class"
                !inClass && c == '[' -> inClass = true
                !inClass && c == ']' -> return "unescaped ']' outside a character class"
                !inClass && c == '{' -> {
                    val q = quantifier.find(p.substring(i)) ?: return "'{' that isn't a quantifier"
                    i += q.value.length
                    continue
                }
                !inClass && c == '}' -> return "unescaped '}'"
            }
            i++
        }
        return null
    }
}
