pluginManagement {
  repositories {
    google {
      content {
        includeGroupByRegex("com\\.android.*")
        includeGroupByRegex("com\\.google.*")
        includeGroupByRegex("androidx.*")
      }
    }
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "dash-android"

include(":core:contracts")
include(":core:auth")
include(":core:security")
include(":core:network")
include(":core:database")
include(":core:sync")
include(":core:designsystem")
include(":core:testing")
include(":feature:account")
include(":feature:approval")
include(":feature:conversations")
include(":feature:chat")
include(":feature:agents")
include(":feature:settings")
include(":benchmark")
include(":integration-fixtures")
include(":app")
