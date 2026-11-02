idf_component_register(
  SRCS "main.c" "net.c" "portal.c" "local.c" "clock.c" "labhost.c"
  INCLUDE_DIRS "."
  REQUIRES pthread esp_driver_gpio esp_driver_ledc esp_driver_i2c esp_driver_uart esp_driver_spi esp_driver_usb_serial_jtag esp_psram esp_adc esp_partition esp_timer mbedtls
           nvs_flash esp_wifi esp_netif esp_event app_update json esp_http_server lwip
)

# The local page, gzipped at build time (-n: no name or date, so builds stay reproducible).
set(LOCAL_PAGE_GZ ${CMAKE_CURRENT_BINARY_DIR}/index.html.gz)
add_custom_command(OUTPUT ${LOCAL_PAGE_GZ}
  COMMAND gzip -9 -n -c ${CMAKE_CURRENT_SOURCE_DIR}/local_page/index.html > ${LOCAL_PAGE_GZ}
  DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/local_page/index.html
  VERBATIM)
add_custom_target(local_page_gz DEPENDS ${LOCAL_PAGE_GZ})
target_add_binary_data(${COMPONENT_LIB} ${LOCAL_PAGE_GZ} BINARY DEPENDS local_page_gz)
