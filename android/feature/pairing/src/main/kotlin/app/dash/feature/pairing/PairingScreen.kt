package app.dash.feature.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun PairingScreen(
    viewModel: PairingViewModel,
    onScanClick: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var host by rememberSaveable { mutableStateOf("") }
    var mgmtToken by rememberSaveable { mutableStateOf("") }
    var chatToken by rememberSaveable { mutableStateOf("") }
    val current = state

    Column(
        Modifier
            .fillMaxSize()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Connect to Dash", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Open Mission Control → Pair device and scan the QR code, or enter the connection details manually.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(onClick = onScanClick, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Default.QrCodeScanner, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Scan QR code")
        }
        Text(
            "or enter manually",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        OutlinedTextField(
            value = host,
            onValueChange = { host = it },
            label = { Text("Host or IP") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = mgmtToken,
            onValueChange = { mgmtToken = it },
            label = { Text("Management token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = chatToken,
            onValueChange = { chatToken = it },
            label = { Text("Chat token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        if (current is PairingUiState.Error) {
            Text(current.message, color = MaterialTheme.colorScheme.error)
        }
        Button(
            onClick = { viewModel.submitManual(host, mgmtToken, chatToken) },
            enabled = current !is PairingUiState.Validating,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (current is PairingUiState.Validating) {
                CircularProgressIndicator(
                    Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
            } else {
                Text("Connect")
            }
        }
    }
}
