package app.dash.core.contracts

import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Serializable
data class FixtureManifest(val version: Int, val cases: List<FixtureCase>)

@Serializable
data class FixtureCase(
  val file: String,
  val document: WireDocument,
  val schema: String,
  val valid: Boolean,
  val format: String? = null,
)

object FixtureLoader {
  private val root = File(
    requireNotNull(requireNotNull(javaClass.classLoader).getResource("manifest.json")).toURI(),
  ).parentFile

  fun manifest(): FixtureManifest = ContractJson.strict.decodeFromString(
    File(root, "manifest.json").readText(),
  )

  fun value(file: String): JsonElement =
    ContractJson.strict.parseToJsonElement(File(root, file).readText())

  fun values(case: FixtureCase): List<JsonElement> {
    val raw = File(root, case.file).readText()
    return when (case.format) {
      "jsonl" -> raw.lineSequence()
        .filter(String::isNotBlank)
        .map(ContractJson.strict::parseToJsonElement)
        .toList()
      "sse" -> {
        require(raw.endsWith("\n\n")) { "${case.file}: SSE fixture must end with a blank line" }
        raw.dropLast(2).split("\n\n").map { block ->
          val lines = block.lineSequence().filter(String::isNotBlank).toList()
          require(lines.size == 2) {
            "${case.file}: SSE block must have exactly event and data"
          }
          val event = lines.single { it.startsWith("event: ") }.removePrefix("event: ")
          val data = lines.single { it.startsWith("data: ") }.removePrefix("data: ")
          ContractJson.strict.parseToJsonElement(data).also { value ->
            require(value.jsonObject.getValue("type").jsonPrimitive.content == event) {
              "${case.file}: SSE event must equal body type"
            }
          }
        }
      }
      null -> listOf(ContractJson.strict.parseToJsonElement(raw))
      else -> throw IllegalArgumentException(
        "${case.file}: unsupported fixture format ${case.format}",
      )
    }
  }
}
