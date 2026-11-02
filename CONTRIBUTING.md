# Contributing

Thank you for helping. Drivers for real equipment (pumps, heat pumps, drives, meters) are the most
valuable contributions: say which model you tested on, and add a simulated device to the tests.

- Sign off your commits (`git commit -s`): it certifies the
  [Developer Certificate of Origin](https://developercertificate.org/), that you wrote the change
  or have the right to submit it under the Apache License 2.0.
- Keep the firmware building for esp32, esp32s3 and esp32c3, and `npm test -w @esp/runtime-sdk`
  passing.
- Protocol facts need a source: a manual, a vendor document, or a capture from real hardware.
  Don't guess register numbers.
- Pull requests are reviewed against the main ESP Lab repository and published here from there.
