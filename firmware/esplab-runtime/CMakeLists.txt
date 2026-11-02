cmake_minimum_required(VERSION 3.16)
# WAMR tags linear-memory allocations, so the runtime can serve them from a block reserved at boot.
set(WAMR_BUILD_ALLOC_WITH_USAGE 1 CACHE INTERNAL "")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(esplab-runtime)
