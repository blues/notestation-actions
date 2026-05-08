# notestation-actions

GitHub Actions for reserving [Notestations](https://github.com/blues/notestation) in CI workflows.

## Actions

### `reserve_notestation`

Reserves a Notestation and exposes its resources for subsequent steps. The reservation is automatically released when the job ends (including on failure or cancellation). Requires Tailscale connectivity before this action runs:

```yaml
- name: Connect to Tailscale
  uses: tailscale/github-action@v3
  with:
    oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
    oauth-secret: ${{ secrets.TS_OAUTH_CLIENT_SECRET }}
    tags: tag:ci
    version: latest
    use-cache: 'true'
```

TODO: Add Note that the TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET secrets are set at the Blues GitHub org level so they're available for use in any blues repo.

**Inputs**

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `notestation` | No | | Specific Notestation hostname to reserve. Mutually exclusive with `tags`. |
| `tags` | No | | Space-separated tags. Reserves the first reachable Notestation matching all tags. Mutually exclusive with `notestation`. |
| `force` | No | `false` | Force the reservation, disconnecting any current holder. |
| `timeout` | No | `60` | Seconds to wait for the reservation to be granted. |
| `notecard-firmware` | No | | Notecard firmware to flash after reservation. Accepts an S3 folder URI, S3 file URI, or `nightly`. |
| `version` | No | | notestation-client version to install if not already on `PATH` (e.g. `v1.2.3`). |
| `token` | No | `github.token` | GitHub token with read access to the blues/notestation repo. |

**Outputs**

| Name | Description |
|------|-------------|
| `ns_hostname` | Reserved Notestation hostname |
| `ns_reservation_dir` | Path to the reservation directory |
| `ns_notecard_usb` | Notecard USB virtual serial device |
| `ns_notecard_aux_uart` | Notecard AUX UART virtual serial device |
| `ns_notecard_lp_uart` | Notecard LP UART virtual serial device |
| `ns_host_mcu_usb` | Host MCU USB virtual serial device |
| `ns_host_mcu_uart0` | Host MCU UART0 virtual serial device |
| `ns_host_mcu_uart1` | Host MCU UART1 virtual serial device |
| `ns_starnote_usb` | Starnote USB virtual serial device |
| `ns_dbus_address` | D-Bus address for GPIO access via gpiocli |

All outputs are also exported as environment variables (uppercased) for use without `steps.<id>.outputs`.

---

### `install_notestation_client`

Downloads and installs the `notestation-client` binary for the current runner (linux/amd64 or linux/arm64). Use this action if you need to use `notestation-client` directly.

**Inputs**

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `version` | Yes | | Release version to install (e.g. `v1.2.3`). |
| `token` | No | `github.token` | GitHub token with read access to the blues/notestation repo. |

## Usage

Real-world examples:

- [note-c card.binary tests](https://github.com/blues/note-c/blob/master/.github/workflows/notecard-binary-tests.yml)
- [e2e tests](https://github.com/blues/hub/blob/main/.github/workflows/notestation-e2e.yml)

### Reserve by hostname

```yaml
- name: Reserve Notestation
  uses: blues/notestation-actions/reserve_notestation@v1.0.2
  with:
    notestation: barcelona-notestation-1
    timeout: '120'
    version: notestation-v3.2.2
    token: ${{ secrets.NOTESTATION_TOKEN }}

- name: Run tests
  run: |
    export TEST_PORT="$NS_NOTECARD_USB"
    make test
```

### Reserve by tags and flash firmware

```yaml
- name: Reserve Notestation and flash firmware
  uses: blues/notestation-actions/reserve_notestation@v1.0.2
  with:
    tags: mcu_swan notecard_debugger
    notecard-firmware: s3://notecard-firmware/
    timeout: '300'
    version: notestation-v3.2.2
    token: ${{ secrets.NOTESTATION_TOKEN }}

- name: Run tests
  run: |
    export REQUEST_PORT="$NS_NOTECARD_USB"
    export TRACE_PORT="$NS_NOTECARD_AUX_UART"
    make test
```

### Install notestation-client separately

```yaml
- name: Install notestation-client
  uses: blues/notestation-actions/install_notestation_client@v1.0.2
  with:
    version: notestation-v3.2.2
    token: ${{ secrets.NOTESTATION_TOKEN }}

- name: Reserve Notestation
  uses: blues/notestation-actions/reserve_notestation@v1.0.2
  with:
    notestation: barcelona-notestation-1
    token: ${{ secrets.NOTESTATION_TOKEN }}
```
