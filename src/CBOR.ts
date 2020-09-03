/** @hidden */
const POW_2_24 = 5.960464477539063e-8
/** @hidden */
const POW_2_32 = 4294967296
/** @hidden */
const POW_2_53 = 9007199254740992
/** @hidden */
const DECODE_CHUNK_SIZE = 8192

type TaggedValueFunction = (value: number, tag: number) => TaggedValue
type SimpleValueFunction = (value: number) => SimpleValue

export class TaggedValue {
  constructor (value: number, tag: number) {
    this.value = value
    this.tag = tag
  }

  value: number
  tag: number
}

export class SimpleValue {
  constructor (value: any) {
    this.value = value
  }

  value: number
}

export function decode (data: ArrayBuffer | SharedArrayBuffer, tagger?: TaggedValueFunction, simpleValue?: SimpleValueFunction): any {
  let dataView = new DataView(data)
  let ta = new Uint8Array(data)
  let offset = 0

  if (typeof tagger !== 'function')
    tagger = function (value: number, tag: number): any {
      return value
    }
  if (typeof simpleValue !== 'function')
    simpleValue = function (value: number): SimpleValue {
      return undefined
    }

  function commitRead<T> (length: number, value: T): T {
    offset += length
    return value
  }
  function readArrayBuffer (length: number) {
    return commitRead(length, new Uint8Array(data, offset, length))
  }
  function readFloat16 () {
    let tempArrayBuffer = new ArrayBuffer(4)
    let tempDataView = new DataView(tempArrayBuffer)
    let value = readUint16()

    let sign = value & 0x8000
    let exponent = value & 0x7c00
    let fraction = value & 0x03ff

    if (exponent === 0x7c00) exponent = 0xff << 10
    else if (exponent !== 0) exponent += (127 - 15) << 10
    else if (fraction !== 0) return (sign ? -1 : 1) * fraction * POW_2_24

    tempDataView.setUint32(0, (sign << 16) | (exponent << 13) | (fraction << 13))
    return tempDataView.getFloat32(0)
  }
  function readFloat32 (): number {
    return commitRead(4, dataView.getFloat32(offset))
  }
  function readFloat64 (): number {
    return commitRead(8, dataView.getFloat64(offset))
  }
  function readUint8 (): number {
    return commitRead(1, ta[offset])
  }
  function readUint16 (): number {
    return commitRead(2, dataView.getUint16(offset))
  }
  function readUint32 (): number {
    return commitRead(4, dataView.getUint32(offset))
  }
  function readUint64 (): number {
    return readUint32() * POW_2_32 + readUint32()
  }
  function readBreak (): boolean {
    if (ta[offset] !== 0xff) return false
    offset += 1
    return true
  }
  function readLength (additionalInformation: number): number {
    if (additionalInformation < 24) return additionalInformation
    if (additionalInformation === 24) return readUint8()
    if (additionalInformation === 25) return readUint16()
    if (additionalInformation === 26) return readUint32()
    if (additionalInformation === 27) return readUint64()
    if (additionalInformation === 31) return -1
    throw 'Invalid length encoding'
  }
  function readIndefiniteStringLength (majorType: number): number {
    let initialByte = readUint8()
    if (initialByte === 0xff) return -1
    let length = readLength(initialByte & 0x1f)
    if (length < 0 || initialByte >> 5 !== majorType) throw 'Invalid indefinite length element'
    return length
  }

  function appendUtf16Data (utf16data: number[], length: number) {
    for (let i = 0; i < length; ++i) {
      let value = readUint8()
      if (value & 0x80) {
        if (value < 0xe0) {
          value = ((value & 0x1f) << 6) | (readUint8() & 0x3f)
          length -= 1
        } else if (value < 0xf0) {
          value = ((value & 0x0f) << 12) | ((readUint8() & 0x3f) << 6) | (readUint8() & 0x3f)
          length -= 2
        } else {
          value =
            ((value & 0x0f) << 18) | ((readUint8() & 0x3f) << 12) | ((readUint8() & 0x3f) << 6) | (readUint8() & 0x3f)
          length -= 3
        }
      }

      if (value < 0x10000) {
        utf16data.push(value)
      } else {
        value -= 0x10000
        utf16data.push(0xd800 | (value >> 10))
        utf16data.push(0xdc00 | (value & 0x3ff))
      }
    }
  }

  function decodeItem (): any {
    let initialByte = readUint8()
    let majorType = initialByte >> 5
    let additionalInformation = initialByte & 0x1f
    let i
    let length

    if (majorType === 7) {
      switch (additionalInformation) {
        case 25:
          return readFloat16()
        case 26:
          return readFloat32()
        case 27:
          return readFloat64()
      }
    }

    length = readLength(additionalInformation)
    if (length < 0 && (majorType < 2 || 6 < majorType)) throw 'Invalid length'

    switch (majorType) {
      case 0:
        return length
      case 1:
        return -1 - length
      case 2:
        if (length < 0) {
          let elements = []
          let fullArrayLength = 0
          while ((length = readIndefiniteStringLength(majorType)) >= 0) {
            fullArrayLength += length
            elements.push(readArrayBuffer(length))
          }
          let fullArray = new Uint8Array(fullArrayLength)
          let fullArrayOffset = 0
          for (i = 0; i < elements.length; ++i) {
            fullArray.set(elements[i], fullArrayOffset)
            fullArrayOffset += elements[i].length
          }
          return fullArray
        }
        return readArrayBuffer(length)
      case 3:
        let utf16data: number[] = []
        if (length < 0) {
          while ((length = readIndefiniteStringLength(majorType)) >= 0) appendUtf16Data(utf16data, length)
        } else {
          appendUtf16Data(utf16data, length)
        }
        let string = ''
        for (i = 0; i < utf16data.length; i += DECODE_CHUNK_SIZE) {
          string += String.fromCharCode.apply(null, utf16data.slice(i, i + DECODE_CHUNK_SIZE))
        }
        return string
      case 4:
        let retArray
        if (length < 0) {
          retArray = []
          while (!readBreak()) retArray.push(decodeItem())
        } else {
          retArray = new Array(length)
          for (i = 0; i < length; ++i) retArray[i] = decodeItem()
        }
        return retArray
      case 5:
        let retObject = {}
        for (i = 0; i < length || (length < 0 && !readBreak()); ++i) {
          let key = decodeItem()
          retObject[key] = decodeItem()
        }
        return retObject
      case 6:
        return tagger(decodeItem(), length)
      case 7:
        switch (length) {
          case 20:
            return false
          case 21:
            return true
          case 22:
            return null
          case 23:
            return undefined
          default:
            return simpleValue(length)
        }
    }
  }

  let ret = decodeItem()
  if (offset !== data.byteLength) throw 'Remaining bytes'
  return ret
}

export function encode (value: any): ArrayBuffer {
  let data = new ArrayBuffer(256)
  let dataView = new DataView(data)
  let byteView = new Uint8Array(data)
  let lastLength: number
  let offset = 0

  function prepareWrite (length: number): DataView {
    let newByteLength = data.byteLength
    let requiredLength = offset + length
    while (newByteLength < requiredLength) newByteLength <<= 1
    if (newByteLength !== data.byteLength) {
      let oldDataView = dataView
      data = new ArrayBuffer(newByteLength)
      dataView = new DataView(data)
      byteView = new Uint8Array(data)
      let uint32count = (offset + 3) >> 2
      for (let i = 0; i < uint32count; ++i) dataView.setUint32(i << 2, oldDataView.getUint32(i << 2))
    }

    lastLength = length
    return dataView
  }
  function commitWrite (...args: any[]) {
    offset += lastLength
  }
  function writeFloat64 (value: number) {
    commitWrite(prepareWrite(8).setFloat64(offset, value))
  }
  function writeUint8 (value: number) {
    commitWrite(prepareWrite(1).setUint8(offset, value))
  }
  function writeUint8Array (value: number[] | Uint8Array) {
    prepareWrite(value.length)
    byteView.set(value, offset)
    commitWrite()
  }
  function writeUint16 (value: number) {
    commitWrite(prepareWrite(2).setUint16(offset, value))
  }
  function writeUint32 (value: number) {
    commitWrite(prepareWrite(4).setUint32(offset, value))
  }
  function writeUint64 (value: number) {
    let low = value % POW_2_32
    let high = (value - low) / POW_2_32
    let dataView = prepareWrite(8)
    dataView.setUint32(offset, high)
    dataView.setUint32(offset + 4, low)
    commitWrite()
  }
  function writeTypeAndLength (type: number, length: number) {
    if (length < 24) {
      writeUint8((type << 5) | length)
    } else if (length < 0x100) {
      writeUint8((type << 5) | 24)
      writeUint8(length)
    } else if (length < 0x10000) {
      writeUint8((type << 5) | 25)
      writeUint16(length)
    } else if (length < 0x100000000) {
      writeUint8((type << 5) | 26)
      writeUint32(length)
    } else {
      writeUint8((type << 5) | 27)
      writeUint64(length)
    }
  }

  function encodeItem (value: any) {
    let i

    if (value === false) return writeUint8(0xf4)
    if (value === true) return writeUint8(0xf5)
    if (value === null) return writeUint8(0xf6)
    if (value === undefined) return writeUint8(0xf7)
    if (Object.is(value, -0)) return writeUint8Array([0xf9, 0x80, 0x00])

    switch (typeof value) {
      case 'number':
        if (Math.floor(value) === value) {
          if (0 <= value && value <= POW_2_53) return writeTypeAndLength(0, value)
          if (-POW_2_53 <= value && value < 0) return writeTypeAndLength(1, -(value + 1))
        }
        writeUint8(0xfb)
        return writeFloat64(value)

      case 'string':
        let utf8data = []
        for (i = 0; i < value.length; ++i) {
          let charCode = value.charCodeAt(i)
          if (charCode < 0x80) {
            utf8data.push(charCode)
          } else if (charCode < 0x800) {
            utf8data.push(0xc0 | (charCode >> 6))
            utf8data.push(0x80 | (charCode & 0x3f))
          } else if (charCode < 0xd800 || charCode >= 0xe000) {
            utf8data.push(0xe0 | (charCode >> 12))
            utf8data.push(0x80 | ((charCode >> 6) & 0x3f))
            utf8data.push(0x80 | (charCode & 0x3f))
          } else {
            charCode = (charCode & 0x3ff) << 10
            charCode |= value.charCodeAt(++i) & 0x3ff
            charCode += 0x10000

            utf8data.push(0xf0 | (charCode >> 18))
            utf8data.push(0x80 | ((charCode >> 12) & 0x3f))
            utf8data.push(0x80 | ((charCode >> 6) & 0x3f))
            utf8data.push(0x80 | (charCode & 0x3f))
          }
        }

        writeTypeAndLength(3, utf8data.length)
        return writeUint8Array(utf8data)

      default:
        let length
        let converted
        if (Array.isArray(value)) {
          length = value.length
          writeTypeAndLength(4, length)
          for (i = 0; i < length; ++i) encodeItem(value[i])
        } else if (value instanceof Uint8Array) {
          writeTypeAndLength(2, value.length)
          writeUint8Array(value)
        } else if (ArrayBuffer.isView(value)) {
          converted = new Uint8Array(value.buffer)
          writeTypeAndLength(2, converted.length)
          writeUint8Array(converted)
        } else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
          converted = new Uint8Array(value)
          writeTypeAndLength(2, converted.length)
          writeUint8Array(converted)
        } else {
          let keys = Object.keys(value)
          length = keys.length
          writeTypeAndLength(5, length)
          for (i = 0; i < length; ++i) {
            let key = keys[i]
            encodeItem(key)
            encodeItem(value[key])
          }
        }
    }
  }

  encodeItem(value)

  if ('slice' in data) return data.slice(0, offset)

  let ret = new ArrayBuffer(offset)
  let retView = new DataView(ret)
  for (let i = 0; i < offset; ++i) retView.setUint8(i, dataView.getUint8(i))
  return ret
}

export const CBOR: {
  decode: (data: ArrayBuffer | SharedArrayBuffer, tagger?: TaggedValueFunction, simpleValue?: SimpleValueFunction) => any
  encode: (value: any) => ArrayBuffer
} = {
  decode,
  encode
}
