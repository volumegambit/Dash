package app.dash.designsystem

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val DashColorScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Foreground,
    background = Background,
    onBackground = Foreground,
    surface = Surface,
    onSurface = Foreground,
    surfaceVariant = SurfaceCard,
    onSurfaceVariant = Muted,
    error = ErrorRed,
    outline = BorderColor,
)

@Composable
fun DashTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DashColorScheme,
        typography = DashTypography,
        content = content,
    )
}
